# Small test http server to test 429 dynamic support
# This server will return 429 status code with Retry-After header
# The Retry-After header will be 2^(request_count - 1) seconds
# The server will do 5 429s before returning a 200 status code, respecting the Retry-After header

from http.server import BaseHTTPRequestHandler, HTTPServer
import time

class RequestHandler(BaseHTTPRequestHandler):
	request_count = 0
	can_accept_request_time = 0

	def do_GET(self):
		if self.path == '/favicon.ico':
			self.send_response(204)
			self.end_headers()
			return

		if time.time() < RequestHandler.can_accept_request_time:
			self.send_response(429)
			self.send_header('Content-type', 'text/html')
			self.send_header('Retry-After', str(int(RequestHandler.can_accept_request_time - time.time())))
			self.end_headers()
			self.wfile.write(b'Too Many Requests')
			return

		if RequestHandler.request_count <= 4:
			RequestHandler.request_count += 1
			retry_after = 2 ** (RequestHandler.request_count - 1)
			self.send_response(429)
			self.send_header('Content-type', 'text/html')
			self.send_header('Retry-After', str(retry_after))
			self.end_headers()
			self.wfile.write(b'Too Many Requests')
		else:
			self.send_response(200)
			self.send_header('Content-type', 'text/html')
			self.end_headers()
			self.wfile.write(b'Hello World!')

def run(server_class=HTTPServer, handler_class=RequestHandler, port=8080):
	server_address = ('', port)
	httpd = server_class(server_address, handler_class)
	print(f'Starting httpd server on port {port}')
	httpd.serve_forever()

if __name__ == "__main__":
	run()
