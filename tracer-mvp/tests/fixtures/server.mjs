import http from "node:http";

const pages = {
  "/ok.html":
    "<!doctype html><html><head><title>F5 OK</title></head>" +
    "<body><h1>Judul F5</h1><p id='isi'>Isi halaman probe F5.</p></body></html>",
};

http
  .createServer((req, res) => {
    const body = pages[req.url];
    if (body === undefined) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  })
  .listen(8765, "127.0.0.1", () => console.log("f5 server on 8765"));
