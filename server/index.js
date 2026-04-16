import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/scrape', (req, res) => {
  res.json({ message: 'Scrape endpoint — not yet implemented' });
});

app.get('/api/history', (req, res) => {
  res.json({ message: 'History endpoint — not yet implemented' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
