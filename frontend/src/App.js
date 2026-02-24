import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import './App.css';

const socket = io('http://localhost:3001'); 

const App = () => {
  const [inLobby, setInLobby] = useState(true);
  const [joinCode, setJoinCode] = useState('');
  const [currentRoomId, setCurrentRoomId] = useState(null);
  
  const [gameState, setGameState] = useState(null);
  const [playerColor, setPlayerColor] = useState(null); 
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [selectedGraveyardIndex, setSelectedGraveyardIndex] = useState(null);
  const [validMoves, setValidMoves] = useState([]); 
  const [selectedArrow, setSelectedArrow] = useState('↑');

  const [timeLeft, setTimeLeft] = useState(30);

  useEffect(() => {
    socket.on('gameJoined', (roomId) => {
        setCurrentRoomId(roomId);
        setInLobby(false);
    });

    socket.on('errorMsg', (msg) => { alert(msg); });

    socket.on('gameStateUpdate', (newState) => {
      setGameState(newState);
      setSelectedSquare(null);
      setSelectedGraveyardIndex(null);
      setValidMoves([]); 
    });

    socket.on('assignColor', (color) => { setPlayerColor(color); });

    return () => socket.off();
  }, []);

  useEffect(() => {
    if (gameState && gameState.status === 'playing' && !gameState.winner) {
        const interval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - gameState.turnStartTime) / 1000);
            const remaining = Math.max(0, 30 - elapsed);
            setTimeLeft(remaining);

            if (remaining === 0 && gameState.turn === playerColor) {
                socket.emit('claimTimeout', { roomId: currentRoomId });
            }
        }, 1000);
        return () => clearInterval(interval);
    }
  }, [gameState, currentRoomId, playerColor]);

  const getValidMoves = (board, piece, fromRow, fromCol) => {
      const moves = [];
      for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
              if (r === fromRow && c === fromCol) continue;
              const targetSquare = board[r][c];
              if (targetSquare === 'BLOCKED') continue;
              if (targetSquare && targetSquare.color === piece.color) continue;
              if (targetSquare && targetSquare.type === 'medic') continue;

              const rowDiff = r - fromRow;
              const colDiff = c - fromCol;
              const absRowDiff = Math.abs(rowDiff);
              const absColDiff = Math.abs(colDiff);

              const isPathClear = (rDir, cDir) => {
                  let currR = fromRow + rDir;
                  let currC = fromCol + cDir;
                  while (currR !== r || currC !== c) {
                      if (board[currR][currC] !== null) return false;
                      currR += rDir;
                      currC += cDir;
                  }
                  return true;
              };

              let isValid = false;
              switch (piece.type) {
                  case 'king': isValid = (absRowDiff <= 1 && absColDiff <= 1); break;
                  case 'knight': isValid = ((absRowDiff === 2 && absColDiff === 1) || (absRowDiff === 1 && absColDiff === 2)); break;
                  case 'rook': if (fromRow === r || fromCol === c) isValid = isPathClear(Math.sign(rowDiff), Math.sign(colDiff)); break;
                  case 'bishop': if (absRowDiff === absColDiff) isValid = isPathClear(Math.sign(rowDiff), Math.sign(colDiff)); break;
                  case 'queen': if (fromRow === r || fromCol === c || absRowDiff === absColDiff) isValid = isPathClear(Math.sign(rowDiff), Math.sign(colDiff)); break;
                  case 'pawn':
                      const forward = piece.direction === 'up' ? -1 : 1;
                      if (colDiff === 0 && rowDiff === forward && targetSquare === null) isValid = true;
                      if (absColDiff === 1 && rowDiff === forward && targetSquare !== null) isValid = true;
                      break;
                  default: isValid = false;
              }
              if (isValid) moves.push({ row: r, col: c });
          }
      }
      return moves;
  };

  const handleSquareClick = (row, col) => {
    if (gameState.winner || gameState.turn !== playerColor) return;
    const clickedSquare = gameState.board[row][col];

    if (gameState.phase === 'holding_drawn_card') {
      if (clickedSquare === null) {
        let pawnDirection = 'up';
        if (playerColor === 'black') pawnDirection = selectedArrow === '↑' ? 'up' : 'down';
        else pawnDirection = selectedArrow === '↑' ? 'down' : 'up';
        socket.emit('deployCard', { roomId: currentRoomId, row, col, playerColor, pawnDirection });
      } else alert("Must deploy on an empty square!");
      return;
    }

    if (selectedGraveyardIndex !== null) {
      if (clickedSquare && clickedSquare.type === 'medic' && clickedSquare.color === playerColor) {
        socket.emit('revivePiece', { roomId: currentRoomId, medicLocation: { row, col }, graveyardIndex: selectedGraveyardIndex, playerColor });
      } else alert("Select one of your Medics to revive this piece!");
      return;
    }

    if (!selectedSquare && clickedSquare && clickedSquare.color === playerColor) {
      if (clickedSquare.type === 'medic') { alert("Medics cannot move!"); return; }
      setSelectedSquare({ row, col });
      setValidMoves(getValidMoves(gameState.board, clickedSquare, row, col));
    } else if (selectedSquare) {
      if (selectedSquare.row === row && selectedSquare.col === col) {
          setSelectedSquare(null);
          setValidMoves([]);
          return;
      }
      socket.emit('movePiece', { roomId: currentRoomId, from: selectedSquare, to: { row, col }, playerColor });
      setSelectedSquare(null);
      setValidMoves([]);
    }
  };

  // UPDATED: Now respects context to invert opponent pieces realistically!
  const renderPieceImage = (piece, context = 'board') => {
      if (!piece) return null;
      let isInverted = false;
      
      if (context === 'hand') {
          // 1. In Hand: Only invert pawns if the Down arrow is clicked
          if (piece.type === 'pawn' && selectedArrow === '↓') isInverted = true;
      } else if (context === 'graveyard') {
          // 2. In Graveyard: Keep all captured opponent pieces right-side up!
          isInverted = false; 
      } else {
          // 3. On the Board:
          if (piece.type === 'pawn') {
              // Pawns flip based on visual direction arrows
              if (playerColor === 'red' && piece.direction === 'up') isInverted = true;
              if (playerColor !== 'red' && piece.direction === 'down') isInverted = true;
          } else {
              // All other pieces flip automatically if they belong to the opponent!
              if (piece.color !== playerColor) isInverted = true;
          }
      }
      
      return <img src={`/pieces/${piece.id}.png`} alt={piece.id} className={`piece-img ${isInverted ? 'inverted-piece' : ''}`} />;
  };

  if (inLobby) {
      return (
          <div className="game-container lobby-container">
              <h1>Tactical Card-Chess</h1>
              <div className="lobby-card">
                  <h2>Host a Game</h2>
                  <button className="draw-btn" onClick={() => socket.emit('createGame')} style={{marginTop: '15px'}}>Create Match</button>
              </div>
              <div className="lobby-card">
                  <h2>Join a Game</h2>
                  <input type="text" placeholder="Enter 4-digit code" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} className="room-input" />
                  <button className="draw-btn" onClick={() => socket.emit('joinGame', joinCode)}>Join Match</button>
              </div>
          </div>
      );
  }

  if (!gameState) return <div className="loading">Loading Game...</div>;

  if (gameState.status === 'waiting') {
      return (
          <div className="game-container">
              <h1>Room Code: <span style={{color: '#2196f3'}}>{currentRoomId}</span></h1>
              <div className="lobby-card" style={{marginTop: '50px'}}>
                  <h2>Waiting for Opponent...</h2>
                  <p>Send the 4-digit code above to your friend.</p>
                  <p style={{fontSize: '0.9rem', color: '#666'}}>The board will reveal automatically when they join.</p>
              </div>
          </div>
      );
  }

  if (gameState.status === 'coin_flip') {
      return (
          <div className="game-container">
              <h1>Room Code: <span style={{color: '#2196f3'}}>{currentRoomId}</span></h1>
              <div className="lobby-card" style={{marginTop: '50px', textAlign: 'center'}}>
                  <h2>Tossing the Coin...</h2>
                  <div className="coin-container"><div className="coin">?</div></div>
                  <p className="coin-result-text">
                      <span style={{color: gameState.turn === 'red' ? '#d32f2f' : '#111'}}>{gameState.turn.toUpperCase()}</span> won the toss!
                  </p>
              </div>
          </div>
      );
  }

  const hasEmptySquare = gameState.board.some(row => row.some(cell => cell === null));
  const enemyColor = playerColor === 'red' ? 'black' : 'red';

  return (
    <div className="game-container">
      <h1>Room Code: <span style={{color: '#2196f3'}}>{currentRoomId}</span></h1>
      
      <div className="game-layout">
        <div className="side-panel">
            {gameState.winner ? (
              <div className="winner-screen">
                <h2 className="winner">GAME OVER!<br/>{gameState.winner.toUpperCase()} WINS!</h2>
                {gameState.consecutiveSkips[gameState.winner === 'red' ? 'black' : 'red'] >= 5 && (
                   <p style={{color: '#d32f2f', fontWeight: 'bold'}}>Opponent went AFK (5 Strikes)</p>
                )}
                <button onClick={() => socket.emit('restartGame', { roomId: currentRoomId })} className="restart-btn">Play Again</button>
              </div>
            ) : (
              <div className="info-box">
                <h2>You are: <span style={{color: playerColor === 'red' ? '#d32f2f' : '#111'}}>{playerColor?.toUpperCase()}</span></h2>
              </div>
            )}

            {/* OPPONENT TIMER & STRIKES */}
            <div className={`timer-box opponent ${gameState.turn === enemyColor && !gameState.winner ? 'active-timer' : ''}`}>
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start'}}>
                    <span className="timer-name">Opponent ({enemyColor.toUpperCase()})</span>
                    {gameState.consecutiveSkips[enemyColor] > 0 && (
                        <span style={{fontSize: '0.8rem', color: '#d32f2f', fontWeight: 'bold'}}>⚠️ Skips: {gameState.consecutiveSkips[enemyColor]}/5</span>
                    )}
                </div>
                <span className={`timer-clock ${gameState.turn === enemyColor && timeLeft <= 10 ? 'low-time' : ''}`}>
                    00:{gameState.turn === enemyColor ? timeLeft.toString().padStart(2, '0') : '30'}
                </span>
            </div>

            <div className="action-panel">
              <button 
                onClick={() => socket.emit('drawCard', { roomId: currentRoomId, playerColor })} 
                disabled={gameState.turn !== playerColor || gameState.phase !== 'idle' || gameState.winner || !hasEmptySquare}
                className="draw-btn"
              >
                Draw Card ({gameState.players[playerColor]?.deck.length} left)
              </button>
              
              {gameState.players[playerColor]?.hand && (
                <div className="hand">
                  You drew: <br/>
                  {/* UPDATED: Pass the 'hand' context */}
                  <div className="piece-preview">
                      {renderPieceImage(gameState.players[playerColor].hand, 'hand')}
                  </div>
                  {gameState.players[playerColor].hand.type === 'pawn' && (
                      <div style={{ marginTop: '10px' }}>
                          <button onClick={() => setSelectedArrow('↑')} style={{ padding: '5px 20px', fontSize: '1.2rem', marginRight: '10px', backgroundColor: selectedArrow === '↑' ? '#2196f3' : '#eee', color: selectedArrow === '↑' ? 'white' : 'black', border: '2px solid #ccc', borderRadius: '4px', cursor: 'pointer' }}>↑</button>
                          <button onClick={() => setSelectedArrow('↓')} style={{ padding: '5px 20px', fontSize: '1.2rem', backgroundColor: selectedArrow === '↓' ? '#2196f3' : '#eee', color: selectedArrow === '↓' ? 'white' : 'black', border: '2px solid #ccc', borderRadius: '4px', cursor: 'pointer' }}>↓</button>
                      </div>
                  )}
                  <br/> <small>Click an empty square to deploy.</small>
                </div>
              )}
            </div>

            {/* YOUR TIMER & STRIKES */}
            <div className={`timer-box you ${gameState.turn === playerColor && !gameState.winner ? 'active-timer' : ''}`}>
                <div style={{display: 'flex', flexDirection: 'column', alignItems: 'flex-start'}}>
                    <span className="timer-name">You ({playerColor?.toUpperCase()})</span>
                    {gameState.consecutiveSkips[playerColor] > 0 && (
                        <span style={{fontSize: '0.8rem', color: '#d32f2f', fontWeight: 'bold'}}>⚠️ Skips: {gameState.consecutiveSkips[playerColor]}/5</span>
                    )}
                </div>
                <span className={`timer-clock ${gameState.turn === playerColor && timeLeft <= 10 ? 'low-time' : ''}`}>
                    00:{gameState.turn === playerColor ? timeLeft.toString().padStart(2, '0') : '30'}
                </span>
            </div>

            <div className="graveyard-panel">
              <h3>Graveyard</h3>
              <div className="graveyard-list">
                {gameState.players[playerColor]?.graveyard.map((p, index) => (
                    <button key={index} className={`graveyard-item ${selectedGraveyardIndex === index ? 'active' : ''}`} onClick={() => setSelectedGraveyardIndex(index)} disabled={gameState.turn !== playerColor || gameState.winner}>
                      {/* UPDATED: Pass the 'graveyard' context */}
                      {renderPieceImage(p, 'graveyard')}
                    </button>
                ))}
                {gameState.players[playerColor]?.graveyard.length === 0 && <p className="empty">Empty</p>}
              </div>
            </div>
        </div>

        {/* --- RIGHT COLUMN: THE BOARD --- */}
        <div className="board-panel">
            <div className={`board ${playerColor === 'red' ? 'flipped' : ''}`}>
              {gameState.board.map((row, rowIndex) => (
                <div key={rowIndex} className="board-row">
                  {row.map((cell, colIndex) => {
                    const isSelected = selectedSquare && selectedSquare.row === rowIndex && selectedSquare.col === colIndex;
                    const isValidTarget = validMoves.some(m => m.row === rowIndex && m.col === colIndex);
                    
                    return (
                      <div key={colIndex} className={`square ${cell === 'BLOCKED' ? 'blocked' : ''} ${isSelected ? 'selected' : ''} ${isValidTarget ? 'valid-target' : ''}`} onClick={() => handleSquareClick(rowIndex, colIndex)}>
                        {cell && cell !== 'BLOCKED' ? (
                          <div className="piece-container">
                            {/* UPDATED: Pass the 'board' context */}
                            {renderPieceImage(cell, 'board')}
                            {cell.type === 'pawn' && <span className="pawn-direction-overlay">{playerColor === 'red' ? (cell.direction === 'up' ? '↓' : '↑') : (cell.direction === 'up' ? '↑' : '↓')}</span>}
                            {cell.type === 'medic' && <span className="medic-badge-overlay">{cell.lifespan}</span>}
                          </div>
                        ) : cell === 'BLOCKED' ? '✖' : ''}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
        </div>
      </div>
    </div>
  );
};

export default App;