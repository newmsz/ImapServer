
const debug = require('debug')('ImapServer:svr');

const EventEmitter = require('events').EventEmitter;
const tls = require('tls');

const Parser = require('imap-parser');

const States = require('./states');
const PluginIterator = require('./pluginIterator');
const util = require('./util');

const TIMEOUT = 30 * 1000;

function ImapConnection(server, stream) {
  EventEmitter.call(this);

  this.server = server;
  this.stream = null;
  this.parser = new Parser();
  this.state = States.NotAuthenticated;
  this.isSecure = false;
  this.onTimeout = this.onTimeout.bind(this);
  this.timeout = setTimeout(this.onTimeout, TIMEOUT);
  this.notes = {
    remoteAddress: stream.remoteAddress,
    remotePort: stream.remotePort
  };

  this.paused = false;
  this.lineBuffer = [];
  this.continueCb = null;

  this.parser.on('data', this.onLine.bind(this));
  this.setStream(stream);

  // errors
  let c = this;
  this.parser.on('end', this.clean.bind(this, false));
  this.stream.on('error', function (e) {
    c.stream._err = e;
    if(e.code != 'ECONNRESET' && e.code != 'EPIPE') {
      debug('Unmanaged:', e, '\n', e.stack);
      throw e;
    }
  });
  this.stream.on('close', this.clean.bind(this, true));

  this.callPlugins('connection', [this], true);
}
module.exports = ImapConnection;
ImapConnection.prototype = Object.create(EventEmitter.prototype);

/*
 *  Plugins support
 */
ImapConnection.prototype.getCapabilities = function () {
  return this.server.getCapabilities(this);
};

ImapConnection.prototype.callPlugins = function (hook, params, all, cb) {
  let connection = this;
  connection.pause();

  if(typeof all == 'function') {
    cb = all;
    all = false;
  }

  let iter = PluginIterator.call(this.server,
    this.server.plugins.slice(0),
    hook, params, all || false,
    function (err) {
      if(typeof cb == 'function') {
        cb.apply(null, arguments);
      } else if(err) {
        console.error('Uncaught plugin error:', err, '\r\n', err.stack);
      }

      process.nextTick(connection.resume.bind(connection));
    });

  process.nextTick(iter);
};

/*
 *  Data receiving
 */
ImapConnection.prototype.continueReq = function (data, cb) {
  let line = '+ ';
  if(typeof data != 'function') {
    line += data.toString();
  } else {
    cb = data;
  }
  this.continueCb = cb;
  this.write(line + '\r\n');
  debug('[%s:%d] <<< %s', this.notes.remoteAddress, this.notes.remotePort, line);
};

ImapConnection.prototype.pause = function () {
  this.stream.unpipe(this.parser);
  this.paused = true;
};

ImapConnection.prototype.resume = function () {
  this.paused = false;
  this.stream.pipe(this.parser);
};

ImapConnection.prototype.onLine = function (line) {
  // timeout reset
  clearTimeout(this.timeout);
  this.timeout = setTimeout(this.onTimeout, TIMEOUT);

  let tag = line[0];
  let cmd = (line[1] || '').toUpperCase();
  let args = line.slice(2);
  switch(cmd) {
    case 'CAPABILITY' :
      let caps = this.server.getCapabilities(this);
      this.send(null, 'CAPABILITY', caps.join(' '));
      this.send(tag, 'OK', 'CAPABILITY completed');
      return;
    case 'NOOP':
      this.send(tag, 'OK', 'NOOP completed');
      return;
    case 'LOGOUT':
      this.send(null, 'BYE', 'See you soon!');
      this.send(tag, 'OK', 'LOGOUT completed');
      this.close();
      return;
  }

  if(this.state == States.NotAuthenticated) {
    switch(cmd) {
      case 'STARTTLS':
        this.callPlugins('starttls', [this, tag]);
        return;
      case 'LOGIN':
        if(args.length < 2) {
          this.send(tag, 'BAD', 'Need a username and password to login');
          return;
        }
        args = util.loginToAuthPlain(args[0], args[1]);
      case 'AUTHENTICATE':
        if(!args.length) {
          this.send(tag, 'BAD', 'Need an authentication mechanism to proceed.');
          return;
        }
        let auth = 'auth_'+args[0].toLowerCase();
        let saslir = args[1] && Buffer.from(args[1], 'base64');
        let connection = this;
        this.callPlugins(auth, [this, saslir || null], afterAuthenticate.bind(this, tag));
        return;
      default:
        this.callPlugins('unknown_command', [this, cmd, args], afterCommand.bind(this, tag));
        return;
    }
  } else if(this.state == States.Authenticated) {
    switch(cmd) {
      case 'CREATE':
      case 'DELETE':
      case 'RENAME':
      case 'UNSUBSCRIBE':
      case 'STATUS':
      case 'APPEND':
      case 'LSUB':
        debug('Received command:', cmd, args);
        this.send(tag, 'BAD', 'Command not implemented');
        return;
      case 'LIST':
        if(args.length != 2) {
          this.send(tag, 'BAD', 'LIST needs 2 arguments');
        } else {
          this.callPlugins('list', [this, args[0], args[1]], afterCommand.bind(this, tag));
        }
        return;
      case 'EXAMINE':
        if(args.length != 1) {
          this.send(tag, 'BAD', 'EXAMINE needs a mailbox name');
        } else {
          this.callPlugins('examine', [this, args[0]], afterSelect.bind(this, tag));
        }
        return;
      case 'SELECT':
        if(args.length != 1) {
          this.send(tag, 'BAD', 'SELECT needs a mailbox name');
        } else {
          this.callPlugins('select', [this, args[0]], afterSelect.bind(this, tag));
        }
        return;
      case 'SUBSCRIBE':
        if(args.length != 1) {
          this.send(tag, 'BAD', 'SUBSCRIBE needs a mailbox name');
        } else {
          this.callPlugins('subscribe', [this, args[0]], afterCommand.bind(this, tag));
        }
        return;
      default:
        this.callPlugins('unknown_command', [this, cmd, args], afterCommand.bind(this, tag));
        return;
    }
  } else if(this.state == States.Selected) {
    switch(cmd) {
      case 'UID':
        this.callPlugins('uid', [this, args[0], args[1], args[2]], afterCommand.bind(this, tag));
        return;
      case 'CLOSE':
        this.callPlugins('close', [this], afterClose.bind(this, tag));
        return;
      case 'FETCH':
        if(args.length != 2) {
          this.send(tag, 'BAD', 'FETCH needs 2 arguments');
        } else {
          this.callPlugins('fetch', [this, args[0], args[1]], afterCommand.bind(this, tag));
        }
        return;
      default:
        this.callPlugins('unknown_command', [this, cmd, args], afterCommand.bind(this, tag));
        return;
    }
  }
};

function afterCommand(code, err, res, msg) {
  if(err) {
    this.send(code, 'BAD',  msg || 'Error processing your request.');
    let _err;
    if(!err.stack) {
      _err = new Error();
    }
    console.error('An error happen:', err, '\r\n', err.stack || _err.stack);
  } else if(res == 'OK') {
    this.send(code, 'OK', msg || 'completed.');
  } else if(res == 'NO') {
    this.send(code, 'NO', msg || 'action refused.');
  } else if(res == 'BAD') {
    this.send(code, 'BAD', msg || 'Client error.');
  } else {
    this.send(code, 'BAD', 'Something strange happen.');
    console.error('Plugin send invalid response:', res, msg);
  }
}

function afterAuthenticate (code, err, res, msg) {
  if(res == 'OK') {
    this.state = States.Authenticated;
    this.send(code, 'OK', msg || 'Success');
  } else if(res == 'NO') {
    this.send(code, 'NO', msg || 'Bad username or password.');
  } else {
    afterCommand.apply(this, arguments);
  }
}

function afterSelect (code, err, res, msg) {
  if(res == 'OK') {
    this.state = States.Selected;
    this.send(code, 'OK', msg || 'SELECT completed');
  } else if(res == 'NO') {
    this.send(code, 'NO', msg || 'SELECT failled');
  } else {
    afterCommand.apply(this, arguments);
  }
}

function afterClose (code, err, res, msg) {
  if(res == 'OK') {
    this.state = States.Authenticated;
    this.send(code, 'OK', msg || 'CLOSE completed');
  } else if(res == 'NO') {
    this.send(code, 'NO', msg || 'CLOSE failled');
  } else {
    afterCommand.apply(this, arguments);
  }
}


/*
 *  Connection state
 */
ImapConnection.prototype.onDisconnect = function () {
  debug('Client Disconnected');
};

ImapConnection.prototype.onTimeout = function () {
  this.send(null, 'BYE', 'Disconnected for inactivity.');
  this.stream.destroySoon();
};

ImapConnection.prototype.close = function () {
  this.stream.destroySoon();
};

ImapConnection.prototype.clean = function (closed, err) {
  clearTimeout(this.timeout);
  if(closed && err) {
    debug('[%s:%d] Disconnect (%s)', this.notes.remoteAddress, this.notes.remotePort, this.stream._err.code);
  } else if(!closed && this.stream.writable) {
    debug('[%s:%d] Closing connection', this.notes.remoteAddress, this.notes.remotePort);
    this.stream.end();
  } else {
    debug('[%s:%d] Disconnect (OK)', this.notes.remoteAddress, this.notes.remotePort);
  }

  this.stream.unpipe(this.parser);
};

ImapConnection.prototype.send = function (id, cmd, info) {
  let msg = `${(id?id:'*')}${cmd?' '+cmd.toUpperCase():''} ${info}`;
  this.stream.write(msg + '\r\n');
  debug('[%s:%d] <<< %s', this.notes.remoteAddress, this.notes.remotePort, msg);
};

ImapConnection.prototype.setStream = function (stream) {
  if(this.stream) {
    this.stream.unpipe(this.parser);
    for(let event in this.stream._events) {
      let listeners = this.stream.listeners(event);
      stream._events[event] = listeners.slice(0);
    }
  }
  this.stream = stream;
  if(!this.paused) {
    stream.pipe(this.parser);
  }
};

ImapConnection.prototype.write = function () {
  return this.stream.write.apply(this.stream, arguments);
};

Object.defineProperty(ImapConnection.prototype, 'secure', {
  // TODO : this crash
  get: function () {
    return (this.stream instanceof tls.CleartextStream);
  }
});
