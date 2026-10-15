// cPanel Phusion Passenger Startup Entrypoint
// In cPanel's "Setup Node.js App", the default entrypoint is often set to "app.js".
// This file delegates directly to server.js so the app works whether "app.js"
// or "server.js" is specified as the Application Startup File.

require('./server.js');
