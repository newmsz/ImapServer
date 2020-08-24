const plugin = module.exports = { };

plugin.connection = function (connection, next) {
  let caps = connection.getCapabilities();
  connection.send(null, 'OK', `[CAPABILITY ${caps.join(' ')}] ${this.notes.announce || ''}`);
  next();
};
