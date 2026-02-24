require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] }
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const gameSchema = new mongoose.Schema({
    roomId: { type: String, unique: true },
    status: { type: String, default: 'waiting' }, 
    board: Array,
    turn: String,
    phase: String,
    players: Object,
    winner: String,
    // NEW: 30-second turn tracking fields
    consecutiveSkips: Object, 
    turnStartTime: Number
});
const Game = mongoose.model('Game', gameSchema);

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function generateArmy(color) {
    let allCards = [];
    allCards.push({ id: `k1_${color}`, type: 'king', color });
    allCards.push({ id: `k2_${color}`, type: 'king', color });
    allCards.push({ id: `m1_${color}`, type: 'medic', color }); 
    allCards.push({ id: `m2_${color}`, type: 'medic', color }); 
    allCards.push({ id: `n1_${color}`, type: 'knight', color });
    allCards.push({ id: `n2_${color}`, type: 'knight', color });
    allCards.push({ id: `b1_${color}`, type: 'bishop', color });
    allCards.push({ id: `b2_${color}`, type: 'bishop', color });
    allCards.push({ id: `r1_${color}`, type: 'rook', color });
    allCards.push({ id: `r2_${color}`, type: 'rook', color });
    allCards.push({ id: `q1_${color}`, type: 'queen', color });
    allCards.push({ id: `q2_${color}`, type: 'queen', color });
    
    for(let i = 0; i < 16; i++) {
        allCards.push({ id: `p${i}_${color}`, type: 'pawn', color, direction: color === 'black' ? 'up' : 'down' });
    }
    
    const kings = allCards.filter(c => c.type === 'king');
    const commoners = allCards.filter(c => c.type !== 'king');
    const shuffledCommoners = shuffle(commoners);
    
    const boardUnits = shuffledCommoners.slice(0, 8);
    const deckUnits = shuffle([...shuffledCommoners.slice(8), ...kings]);
    
    return { boardUnits, deckUnits };
}

function getFreshGameState() {
    const redArmy = generateArmy('red');
    const blackArmy = generateArmy('black');
    const board = Array(4).fill(null).map(() => Array(4).fill(null));

    let redIndex = 0;
    for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
            let piece = redArmy.boardUnits[redIndex++];
            if (piece.type === 'medic') { piece.lifespan = 2; piece.isNew = true; }
            board[r][c] = piece;
        }
    }

    let blackIndex = 0;
    for (let r = 2; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            let piece = blackArmy.boardUnits[blackIndex++];
            if (piece.type === 'medic') { piece.lifespan = 2; piece.isNew = true; }
            board[r][c] = piece;
        }
    }

    return {
        board: board,
        turn: Math.random() < 0.5 ? 'red' : 'black', 
        phase: 'idle',
        players: {
          red: { deck: redArmy.deckUnits, hand: null, graveyard: [], kingsAlive: 2 },
          black: { deck: blackArmy.deckUnits, hand: null, graveyard: [], kingsAlive: 2 }
        },
        winner: null,
        consecutiveSkips: { red: 0, black: 0 },
        turnStartTime: null
    };
}

function evaluateWinCondition(game) {
    if (game.winner) return;
    let redAlive = false;
    let blackAlive = false;

    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const piece = game.board[r][c];
            if (piece && piece !== 'BLOCKED') {
                if (piece.color === 'red') redAlive = true;
                if (piece.color === 'black') blackAlive = true;
            }
        }
    }

    if (!redAlive) game.winner = 'black';
    else if (!blackAlive) game.winner = 'red';
    
    if (game.players.red.kingsAlive <= 0) game.winner = 'black';
    else if (game.players.black.kingsAlive <= 0) game.winner = 'red';
}

// NEW: Takes an `isSkip` flag. If they moved normally, reset their strike counter to 0!
function processTurnSwitch(game, isSkip = false) {
    if (!isSkip) {
        game.consecutiveSkips[game.turn] = 0;
    }

    const nextPlayer = game.turn === 'red' ? 'black' : 'red';
    game.turn = nextPlayer;
    game.phase = 'idle';
    game.turnStartTime = Date.now(); // Reset 30s clock for the next player

    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const piece = game.board[r][c];
            if (piece && piece.type === 'medic' && piece.color === nextPlayer) {
                if (piece.isNew) piece.isNew = false;
                else {
                    piece.lifespan -= 1;
                    if (piece.lifespan <= 0) game.board[r][c] = null; 
                }
            }
        }
    }
    evaluateWinCondition(game);
}

function isValidMove(board, piece, from, to) {
    const targetSquare = board[to.row][to.col];
    if (targetSquare === 'BLOCKED') return false; 
    if (targetSquare && targetSquare.color === piece.color) return false; 
    if (targetSquare && targetSquare.type === 'medic') return false; 

    const rowDiff = to.row - from.row;
    const colDiff = to.col - from.col;
    const absRowDiff = Math.abs(rowDiff);
    const absColDiff = Math.abs(colDiff);

    const isPathClear = (rDir, cDir) => {
        let r = from.row + rDir;
        let c = from.col + cDir;
        while (r !== to.row || c !== to.col) {
            if (board[r][c] !== null) return false; 
            r += rDir;
            c += cDir;
        }
        return true;
    };

    switch (piece.type) {
        case 'king': return absRowDiff <= 1 && absColDiff <= 1;
        case 'knight': return ((absRowDiff === 2 && absColDiff === 1) || (absRowDiff === 1 && absColDiff === 2));
        case 'rook': if (from.row !== to.row && from.col !== to.col) return false; return isPathClear(Math.sign(rowDiff), Math.sign(colDiff));
        case 'bishop': if (absRowDiff !== absColDiff) return false; return isPathClear(Math.sign(rowDiff), Math.sign(colDiff));
        case 'queen': if (from.row !== to.row && from.col !== to.col && absRowDiff !== absColDiff) return false; return isPathClear(Math.sign(rowDiff), Math.sign(colDiff));
        case 'pawn':
            const forward = piece.direction === 'up' ? -1 : 1;
            if (colDiff === 0 && rowDiff === forward) return targetSquare === null;
            if (absColDiff === 1 && rowDiff === forward) return targetSquare !== null;
            return false;
        default: return false;
    }
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createGame', async () => {
      const roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); 
      let gameDoc = new Game({ roomId, status: 'waiting', ...getFreshGameState() });
      await gameDoc.save();
      
      socket.join(roomId); 
      socket.emit('assignColor', 'black');
      socket.emit('gameJoined', roomId);
      io.to(roomId).emit('gameStateUpdate', gameDoc);
  });

  socket.on('joinGame', async (roomId) => {
      roomId = roomId.toUpperCase();
      let gameDoc = await Game.findOne({ roomId });
      
      if (!gameDoc) {
          socket.emit('errorMsg', 'Room not found!');
          return;
      }
      if (gameDoc.status !== 'waiting') {
          socket.emit('errorMsg', 'This room is already full or the game has started!');
          return;
      }

      socket.join(roomId); 
      socket.emit('assignColor', 'red');
      socket.emit('gameJoined', roomId);

      if (gameDoc.status === 'waiting') {
          gameDoc.status = 'coin_flip';
          await gameDoc.save();
          io.to(roomId).emit('gameStateUpdate', gameDoc);

          setTimeout(async () => {
              let currentGame = await Game.findOne({ roomId });
              if (currentGame && currentGame.status === 'coin_flip') {
                  currentGame.status = 'playing';
                  currentGame.turnStartTime = Date.now(); // START THE 30S CLOCK!
                  await currentGame.save();
                  io.to(roomId).emit('gameStateUpdate', currentGame);
              }
          }, 3000);
      }
  });

  // NEW: Process 30-Second Turn Skipped
  socket.on('claimTimeout', async ({ roomId }) => {
      let game = await Game.findOne({ roomId });
      if (!game || game.status !== 'playing' || game.winner) return;

      const elapsedSeconds = Math.floor((Date.now() - game.turnStartTime) / 1000);
      
      if (elapsedSeconds >= 30) {
          game.consecutiveSkips[game.turn] += 1; // Add a strike!

          if (game.consecutiveSkips[game.turn] >= 5) {
              game.winner = game.turn === 'red' ? 'black' : 'red'; // 5 strikes, you're out!
          } else {
              // If they were holding a card, shove it back into their deck
              if (game.phase === 'holding_drawn_card') {
                  game.players[game.turn].deck.push(game.players[game.turn].hand);
                  game.players[game.turn].hand = null;
              }
              processTurnSwitch(game, true); // True means "Yes, this was a skip"
          }

          await Game.updateOne({ _id: game._id }, game);
          io.to(roomId).emit('gameStateUpdate', game);
      }
  });

  socket.on('drawCard', async ({ roomId, playerColor }) => {
      let game = await Game.findOne({ roomId });
      if (game.status !== 'playing') return;
      if (game.turn === playerColor && game.phase === 'idle') {
          if (game.players[playerColor].deck.length > 0) {
              game.players[playerColor].hand = game.players[playerColor].deck.pop();
              game.phase = 'holding_drawn_card';
              await Game.updateOne({ _id: game._id }, game);
              io.to(roomId).emit('gameStateUpdate', game); 
          }
      }
  });

  socket.on('deployCard', async ({ roomId, row, col, playerColor, pawnDirection }) => {
      let game = await Game.findOne({ roomId });
      if (game.status !== 'playing') return;
      if (game.turn === playerColor && game.phase === 'holding_drawn_card') {
          if (game.board[row][col] === null) {
              const cardToDeploy = game.players[playerColor].hand;
              if (cardToDeploy.type === 'medic') { cardToDeploy.lifespan = 2; cardToDeploy.isNew = true; }
              
              if (cardToDeploy.type === 'pawn') {
                  cardToDeploy.direction = pawnDirection;
                  const r = Number(row);
                  if ((cardToDeploy.direction === 'up' && r === 0) || (cardToDeploy.direction === 'down' && r === 3)) {
                      game.board[row][col] = 'BLOCKED'; 
                  } else game.board[row][col] = cardToDeploy; 
              } else game.board[row][col] = cardToDeploy;
              
              game.players[playerColor].hand = null;
              evaluateWinCondition(game);
              if (!game.winner) processTurnSwitch(game, false); // False = Valid move!
              
              await Game.updateOne({ _id: game._id }, game);
              io.to(roomId).emit('gameStateUpdate', game);
          }
      }
  });

  socket.on('revivePiece', async ({ roomId, medicLocation, graveyardIndex, playerColor }) => {
      let game = await Game.findOne({ roomId });
      if (game.status !== 'playing') return;
      if (game.turn !== playerColor) return;

      const medic = game.board[medicLocation.row][medicLocation.col];
      const graveyard = game.players[playerColor].graveyard;

      if (medic && medic.type === 'medic' && medic.color === playerColor) {
          if (graveyard[graveyardIndex]) {
              const revivedPiece = graveyard.splice(graveyardIndex, 1)[0]; 
              game.board[medicLocation.row][medicLocation.col] = revivedPiece;
              
              evaluateWinCondition(game);
              if (!game.winner) processTurnSwitch(game, false);
              
              await Game.updateOne({ _id: game._id }, game);
              io.to(roomId).emit('gameStateUpdate', game);
          }
      }
  });

  socket.on('movePiece', async ({ roomId, from, to, playerColor }) => {
      let game = await Game.findOne({ roomId });
      if (game.status !== 'playing') return;
      if (game.turn !== playerColor || game.phase !== 'idle') return;

      const piece = game.board[from.row][from.col];
      if (!piece || piece.color !== playerColor) return;

      if (isValidMove(game.board, piece, from, to)) {
          const targetSquare = game.board[to.row][to.col];

          if (targetSquare && targetSquare !== 'BLOCKED') {
             const enemyColor = playerColor === 'red' ? 'black' : 'red';
             game.players[enemyColor].graveyard.push(targetSquare);
             if (targetSquare.type === 'king') game.players[enemyColor].kingsAlive -= 1;
          }

          game.board[to.row][to.col] = piece;
          game.board[from.row][from.col] = null;

          if (piece.type === 'pawn') {
              const r = Number(to.row);
              if ((piece.direction === 'up' && r === 0) || (piece.direction === 'down' && r === 3)) game.board[to.row][to.col] = 'BLOCKED';
          }

          evaluateWinCondition(game);
          if (!game.winner) processTurnSwitch(game, false);
          
          await Game.updateOne({ _id: game._id }, game);
          io.to(roomId).emit('gameStateUpdate', game);
      }
  });

  socket.on('restartGame', async ({ roomId }) => {
      let game = await Game.findOne({ roomId });
      const freshState = getFreshGameState(); 
      freshState.status = 'coin_flip';
      await Game.updateOne({ _id: game._id }, freshState);
      io.to(roomId).emit('gameStateUpdate', await Game.findOne({ roomId }));

      setTimeout(async () => {
          let currentGame = await Game.findOne({ roomId });
          if (currentGame && currentGame.status === 'coin_flip') {
              currentGame.status = 'playing';
              currentGame.turnStartTime = Date.now();
              await currentGame.save();
              io.to(roomId).emit('gameStateUpdate', currentGame);
          }
      }, 3000);
  });
});

server.listen(3001, () => {
  console.log('Multiplayer server running on port 3001');
});