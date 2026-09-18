import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// Serve static files from current directory
app.use(express.static(__dirname, {
  extensions: ['html']
}));

// Route rewrites matching vercel.json and README documentation
const spaRoutes = ['/p1', '/p2', '/p3', '/blackhole'];
spaRoutes.forEach((route) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });
});

// Single-page application fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`AR Black Hole server running on http://${HOST}:${PORT}`);
});
