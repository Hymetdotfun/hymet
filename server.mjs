import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ status: 'ok', mode: 'ui-preview', marketData: 'not-configured', transactions: 'disabled' }));
  }
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  const safePath = normalize(requested).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
  let file = join(root, safePath || 'index.html');
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`HYMET preview ready at http://localhost:${port}`));
