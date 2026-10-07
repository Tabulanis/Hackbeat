// War Machine — entry point.
// Everything is plain ES modules, no bundler. Serve the folder over HTTP
// (see README) because browsers refuse to load modules from file://.
import { Game } from './game.js';

const canvas = document.getElementById('game');
const game = new Game(canvas);
game.run();

// Handy for poking at state from the devtools console.
window.warMachine = game;
