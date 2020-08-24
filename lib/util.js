
exports.loginToAuthPlain = function loginToAuthPlain (user, pass) {
  let saslir = `\u0000${user}\u0000${pass}`;
  return [
    'PLAIN',
    Buffer.from(saslir, 'binary').toString('base64')
  ];
};

exports.makeListRegexp = function makeListRegexp(str, delimiter) {
  str = str.replace(/[\-\[\]\/\{\}\(\)\+\?\.\\\^\$\|]/g, "\\$&");
  str = str.replace(/\*/g, '.*').replace(/%/g, '[^'+delimiter+']*');
  return new RegExp('^'+str+'$');
};
