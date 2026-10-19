import http from 'node:http';

const target = new URL(process.env.LOCAL_TARGET_URL);
const port = Number(process.env.LOCAL_LISTEN_PORT);

function options(request) {
  return {
    method: request.method,
    headers: { ...request.headers, host: target.host },
  };
}

const server = http.createServer((incoming, outgoing) => {
  const upstream = http.request(new URL(incoming.url, target), options(incoming), (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end(error.message);
  });
  incoming.pipe(upstream);
});

server.on('upgrade', (request, client, head) => {
  const upstream = http.request(new URL(request.url, target), options(request));
  upstream.on('upgrade', (response, socket, responseHead) => {
    client.write(
      `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n` +
        Object.entries(response.headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join('\r\n') +
        '\r\n\r\n',
    );
    if (head.length) socket.write(head);
    if (responseHead.length) client.write(responseHead);
    socket.pipe(client).pipe(socket);
  });
  upstream.on('error', () => client.destroy());
  upstream.on('response', () => client.destroy());
  upstream.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Local target proxy listening on 127.0.0.1:${port}`);
});
