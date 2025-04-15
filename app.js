const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins for testing; restrict in production
  },
});

app.use(cors());
app.use(express.static(__dirname + '/public'));

const games = {}; // Store game state per room
const rematchRequests = {}; // Track rematch requests

// Scores for each player stored per gameId
const gameScores = {}; // { gameId: { playerId: { wins: 0, losses: 0 } } }

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  socket.on('joinGame', (gameId) => {
    // Initialize game if it doesn't exist
    const game = games[gameId] || { 
      players: [], 
      board: Array(9).fill(''), 
      turn: 'X', 
      gameEnded: false 
    };

    if (game.players.length >= 2) {
      socket.emit('gameFull');
      return;
    }

    const symbol = game.players.length === 0 ? 'X' : 'O';
    game.players.push({ id: socket.id, symbol });
    games[gameId] = game;

    // Initialize scores for this game
    if (!gameScores[gameId]) {
      gameScores[gameId] = {};
    }
    if (!gameScores[gameId][socket.id]) {
      gameScores[gameId][socket.id] = { wins: 0, losses: 0 };
    }

    socket.join(gameId);
    socket.symbol = symbol;
    socket.gameId = gameId;

    // Send current score to player when they join
    socket.emit('scoreUpdate', gameScores[gameId][socket.id]);

    if (game.players.length === 2) {
      game.players.forEach(p => {
        io.to(p.id).emit('gameStart', p.symbol);
      });
    }
  });

  socket.on('makeMove', ({ gameId, index, symbol }) => {
    const game = games[gameId];
    if (!game || game.board[index] || game.turn !== symbol || game.gameEnded) return;

    game.board[index] = symbol;
    game.turn = symbol === 'X' ? 'O' : 'X';

    socket.to(gameId).emit('opponentMove', { index, symbol });

    const winner = checkWinner(game.board);
    if (winner || game.board.every(cell => cell !== '')) {
      io.to(gameId).emit('gameOver', winner);

      // Update the score for the winner and loser
      updateScore(gameId, winner, game.players);

      game.gameEnded = true; // Mark the game as ended
    }
  });

  socket.on('requestRematch', (gameId) => {
    const game = games[gameId];
    if (!game) {
      socket.emit("error", "Game not found.");
      return;
    }

    // Initialize rematch requests array if needed
    if (!rematchRequests[gameId]) rematchRequests[gameId] = [];
    
    // Add this player to rematch requests if not already there
    if (!rematchRequests[gameId].includes(socket.id)) {
      rematchRequests[gameId].push(socket.id);
    }

    // Alert other player that a rematch was requested
    const opponent = game.players.find(p => p.id !== socket.id);
    if (opponent) {
      io.to(opponent.id).emit('rematchRequested');
    }

    // If both players requested a rematch, start new game
    if (rematchRequests[gameId].length === 2) {
      startRematch(gameId);
    }
  });

  socket.on('quitGame', (gameId) => {
    const game = games[gameId];
    if (game) {
      // Notify other player that this player quit
      const opponent = game.players.find(p => p.id !== socket.id);
      if (opponent) {
        io.to(opponent.id).emit('opponentQuit');
      }
      
      // Clean up game resources
      game.gameEnded = true;
      
      // Keep scores in gameScores but clean up the game and rematch requests
      if (rematchRequests[gameId]) {
        delete rematchRequests[gameId];
      }
    }
  });

  socket.on('disconnect', () => {
    const gameId = socket.gameId;
    const game = games[gameId];
    if (game) {
      // Notify other player about disconnect
      const opponent = game.players.find(p => p.id !== socket.id);
      if (opponent) {
        io.to(opponent.id).emit('opponentDisconnected');
      }
      
      // Remove player from game
      game.players = game.players.filter(p => p.id !== socket.id);
      if (game.players.length === 0) {
        delete games[gameId];
        delete gameScores[gameId];
        if (rematchRequests[gameId]) {
          delete rematchRequests[gameId];
        }
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

function startRematch(gameId) {
  const game = games[gameId];
  if (!game) return;
  
  // Reset the game board
  game.board = Array(9).fill('');
  game.turn = 'X';
  game.gameEnded = false;
  
  // Send rematch start notifications to both players
  game.players.forEach(player => {
    io.to(player.id).emit('rematchStart', player.symbol);
  });
  
  // Clear rematch requests
  rematchRequests[gameId] = [];
}

function checkWinner(board) {
  const wins = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
    [0, 4, 8], [2, 4, 6],            // diagonals
  ];
  for (const [a, b, c] of wins) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return board[a]; // 'X' or 'O'
    }
  }
  return null;
}

// Update the score after each round
function updateScore(gameId, winner, players) {
  if (!gameScores[gameId]) {
    gameScores[gameId] = {};
  }

  if (!winner) {
    // It's a draw, no score update
    return;
  }

  const winnerPlayer = players.find(player => player.symbol === winner);
  const loserPlayer = players.find(player => player.symbol !== winner);

  // Update winner's score
  if (!gameScores[gameId][winnerPlayer.id]) {
    gameScores[gameId][winnerPlayer.id] = { wins: 0, losses: 0 };
  }
  gameScores[gameId][winnerPlayer.id].wins++;

  // Update loser's score
  if (!gameScores[gameId][loserPlayer.id]) {
    gameScores[gameId][loserPlayer.id] = { wins: 0, losses: 0 };
  }
  gameScores[gameId][loserPlayer.id].losses++;

  // Notify both players of the score update
  players.forEach(player => {
    io.to(player.id).emit('scoreUpdate', gameScores[gameId][player.id]);
  });
}

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});