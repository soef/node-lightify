var net = require('net');
var moment = require('moment');
var Promise = require('promise');

const
    COMMAND_LIST_ALL_NODE = 0x13,
    COMMAND_LIST_ALL_ZONE = 0x1E,
    COMMAND_BRIGHTNESS = 0x31,
    COMMAND_ONOFF = 0x32,
    COMMAND_TEMP = 0x33,
    COMMAND_COLOR = 0x36,

    COMMAND_SOFT_ON = 0xDB,
    COMMAND_SOFT_OFF = 0xDC,
    COMMAND_GET_ZONE_INFO = 0x26,
    COMMAND_GET_STATUS = 0x68,
    COMMAND_ACTIVATE_SCENE = 0x52;

var groupCommands = [
    COMMAND_BRIGHTNESS,
    COMMAND_ONOFF,
    COMMAND_TEMP,
    COMMAND_COLOR,
    COMMAND_GET_STATUS
]

Buffer.prototype.getOurUTF8String = function (start, end) {
    for (var i=start; i<end && this[i]!==0; i++) {}
    return this.toString('utf-8', start, i);
}

function defaultBuffer(mac, len)  {
    if(len == undefined) len = 9;
    var body = new Buffer(len);
    body.fill(0);
    if (typeof mac == 'string') {
        body.write(mac.substr(0, 16), 0, 'hex');
    } else {
        body.writeDoubleLE(mac, 0);
    }
    return body;
}


var seq = 0;

var lightify = function(ip, logger) {
    this.ip = ip;
    this.commands = [];
    this.logger = logger;
}
lightify.prototype.processData = function(cmd, data) {
    var fail = data.readUInt8(8);
    if(fail && cmd.reject) {
        return cmd.reject({
            cmd : cmd,
            fail : fail,
            response : data.toString('hex')
        });
    }
    var num = data.readUInt16LE(9);
    var result = { result: [] };
    var packageSize = cmd.packageSize || (num && (data.length - 11) / num);
    for (var i = 0; i < num; i++) {
        var pos = 11 + i * packageSize;
        result.result.push(cmd.cb(data, pos));
    }
    result.request = cmd.request;
    result.response = data.toString('hex');
    if (cmd.resolve) {
        cmd.resolve(result);
    }
}
lightify.prototype.connect = function() {
    var self = this;

    return new Promise(function(resolve, reject) {
        self.client = new net.Socket();
        self.connectTimeout = setTimeout(function () {
            reject('connect timeout');
            self.logger && self.logger.debug('can not connect to lightify bridge, timeout');
            self.client.destroy();
        }, 4000);
        self.client.on('data', function(data) {
            self.logger && self.logger.debug('socket data: [%s]', data.toString('hex'))
            if(self.readBuffer && self.readBuffer.length) {
                data = Buffer.concat([self.readBuffer, data]);
            }
            var expectedLen = data.readUInt16LE(0) + 2;
            self.logger && self.logger.debug('Expected len [%s]', expectedLen);
            self.logger && self.logger.debug('len = [%s]', data.length);
            if(expectedLen > data.length) {
                self.readBuffer = new Buffer(data);
                return;
            } else if(expectedLen === data.length){
                self.readBuffer = undefined;
            } else {
                self.readBuffer = new Buffer(data.slice(data.length - expectedLen));
            }
            var seq = data.readUInt32LE(4);
            self.logger && self.logger.debug('got response for seq [%s][%s]', seq, data.toString('hex'));
            for(var i = 0; i < self.commands.length; i++) {
                if(self.commands[i].seq === seq) {
                    clearTimeout(self.commands[i].timer);
                    self.logger && self.logger.debug('found request');
                    self.processData(self.commands[i], data)
                    self.commands.splice(i, 1);
                    break;
                }
            }
        });
        self.client.on('error', function(error) {
            self.logger && self.logger.debug('connection has error', error);
            for(var i = 0; i < self.commands.length; i++) {
                self.commands[i].reject(error);
            }
            self.dispose();
        });
        self.client.connect(4000, self.ip, function() {
            clearTimeout(self.connectTimeout);
            resolve();
        });
    });
}
lightify.prototype.dispose = function () {
    this.commands = [];
    this.client.destroy();
}
lightify.prototype.sendCommand = function(cmdId, body, flag, cb, packageSize) {
    var self = this;
    if (typeof flag == 'function') { cb = flag; flag = 0; }
    return new Promise(function(resolve, reject) {
        var buffer = new Buffer(8 + body.length);

        buffer.fill(0);
        buffer.writeUInt16LE(8 + body.length - 2, 0);// length
        buffer.writeUInt8(flag || 0x00, 2);          // Flag, 0:node, 2:zone
        buffer.writeUInt8(cmdId, 3);                   // command
        buffer.writeUInt32LE(++seq, 4);              // request id
        body.copy(buffer, 8);
        var cmd = {
            seq : seq,
            createTime : moment().format('x'),
            resolve : resolve,
            reject : reject,
            packageSize : packageSize,
            cb :(cb || function(data, pos) {
                return {
                    mac : data.readDoubleLE(pos, 8),
                    friendlyMac : data.toString('hex', pos, pos + 8),
                    success : data.readUInt8(pos + 8)
                };
            }),
            request : buffer.toString('hex')
        };
        cmd.timer = setTimeout(function() {
            self.logger && self.logger.debug('send command timeout [%s][%s]', cmd.seq, buffer.toString('hex'));
            cmd.reject('timeout');
            cmd.resolve = undefined;
            cmd.reject = undefined;
        }, 1000);
        self.logger && self.logger.debug('command sent [%s][%s]', cmd.seq, buffer.toString('hex'));
        self.commands.push(cmd);
        self.client.write(buffer);
    });
}

lightify.prototype.discover = function() {
    var self = this;
    return this.sendCommand(COMMAND_LIST_ALL_NODE, new Buffer([0x1]), function(data, pos) {
        return {
            id: data.readUInt16LE(pos),
            mac: data.readDoubleLE(pos + 2, 8),
            friendlyMac : data.toString('hex', pos + 2, pos + 10),
            type: data.readUInt8(pos + 10),
            firmware_version: data.readUInt32BE(pos + 11),
            online: data.readUInt8(pos + 15),
            groupid: data.readUInt16LE(pos + 16),
            status: data.readUInt8(pos + 18), // 0 == off, 1 == on
            brightness: data.readUInt8(pos + 19),
            temperature: data.readUInt16LE(pos + 20),
            red: data.readUInt8(pos + 22),
            green: data.readUInt8(pos + 23),
            blue: data.readUInt8(pos + 24),
            alpha: data.readUInt8(pos + 25),
            name: data.getOurUTF8String(pos + 26, pos + 50)
        };
    }, 50);
}

lightify.prototype.discoverZone = function() {
    return this.sendCommand(COMMAND_LIST_ALL_ZONE, new Buffer([0x0]), 2, function(data, pos) {
        return {
            id: data.readUInt16LE(pos),
            name: data.getOurUTF8String(pos + 2, pos + 18)
        };
    });
}
lightify.prototype.nodeOnOff = function(mac, on) {
    var body = defaultBuffer(mac);
    body.writeUInt8(on ? 1 : 0, 8);
    return this.sendCommand(COMMAND_ONOFF, body);
}
lightify.prototype.nodeSoftOnOff = function(mac, on, transitiontime) {
    var body = defaultBuffer(mac, 10);
    body.writeUInt16LE(transitiontime || 0, 8);
    return this.sendCommand (on ? COMMAND_SOFT_ON : COMMAND_SOFT_OFF, body);
}
lightify.prototype.activateScene = function(sceneId) {
    var body = new Buffer(2);
    body.writeUInt8(sceneId, 0);
    body.writeUInt8(0, 1);
    return this.sendCommand (COMMAND_ACTIVATE_SCENE, body);
}
lightify.prototype.getZoneInfo = function(zone) {
    var body = new Buffer(2);
    body.writeUInt8(zone, 0);
    body.writeUInt8(0, 1);
    return this.sendCommand (COMMAND_GET_ZONE_INFO, body, 2,
        function(data, pos) {
            var o = {
                groupNo: data.readUInt8(9),
                name: data.getOurUTF8String(11, 26),
                devices: []
            }
            var cnt = data.readUInt8(27);
            for (var i=28; i<data.length; i+=8) {
                o.devices.push({
                    mac : data.readDoubleLE(i, 8),
                    friendlyMac : data.toString('hex', i, i + 8),
                });
            }
            return o;
        }
    );
}
lightify.prototype.getStatus = function(mac) {
    var self = this;
    var body = defaultBuffer(mac, 8);
    return this.sendCommand(COMMAND_GET_STATUS, body, function(data, pos) {
        var o = {
            mac: data.readDoubleLE(11, 8),
            requestStatus: data.readUInt8(19),
            online: 0
        }
        if (o.requestStatus == 0x00) { //0xFF) {
            o.online = data.readUInt8(20);
            o.status = data.readUInt8(21);
            o.brightness = data.readUInt8(22);
            o.temperature = data.readUInt16LE(23);
            o.red = data.readUInt8(25);
            o.green = data.readUInt8(26);
            o.blue = data.readUInt8(27);
            o.alpha = data.readUInt8(28);
        }
        return o;
    }).then(function(device) {
        return Promise.resolve(device.result.length && device.result[0]);
    });
}
lightify.prototype.nodeBrightness = function(mac, brightness, stepTime) {
    var buffer = defaultBuffer(mac, 11);
    buffer.writeUInt8(brightness, 8);
    buffer.writeUInt16LE(stepTime || 0, 9);
    return this.sendCommand(COMMAND_BRIGHTNESS, buffer);
}
lightify.prototype.nodeTemperature = function(mac, temperature, stepTime) {
    var buffer = defaultBuffer(mac, 12);
    buffer.writeUInt16LE(temperature, 8);
    buffer.writeUInt16LE(stepTime || 0, 10);
    return this.sendCommand(COMMAND_TEMP, buffer);
}

lightify.prototype.nodeColor = function(mac, red, green, blue, alpha, stepTime) {
    var buffer = defaultBuffer(mac, 14);
    buffer.writeUInt8(red, 8);
    buffer.writeUInt8(green, 9);
    buffer.writeUInt8(blue, 10);
    buffer.writeUInt8(alpha, 11);
    buffer.writeUInt16LE(stepTime || 0, 12);

    return this.sendCommand(COMMAND_COLOR, buffer);
}


function isPlug(type) {
    return type === 16;
}
function getNodeType(type) {
    return isPlug(type) ? 16 : type;
}
function isSwitch(type) {
    return type === 64 || type === 65;
}
var exports = module.exports = {
    lightify : lightify,
    isPlug : isPlug,
    isSwitch : isSwitch,
    is2BSwitch : function(type) { return type === 64;},
    is4BSwitch : function(type) { return type === 65;},
    isBrightnessSupported : function(type) { return getNodeType(type) === 2 || getNodeType(type) === 4 || (getNodeType(type) != 16 && getNodeType(type) != 1);},
    isTemperatureSupported : function(type) {return getNodeType(type) === 2 || getNodeType(type) === 10; },
    isColorSupported : function(type) { return getNodeType(type) === 10 || getNodeType(type) === 8; },
    isLight : function(type) { return !isSwitch(type) && !isPlug(type); },
    tf: {
        BRI: 0xae, // ((~FT_SWITCH) & (~FT_PLUG)) & 0xff, //0xffee,
        CT: 0x02,
        RGB: 0x08,
        SWITCH: 0x40,
        PLUG: 0x10,
        ALL: 0xff,
        LIGHT: 0xae
    }
};

