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

var __DEBUG__ = true;

Buffer.prototype.getOurUTF8String = function (start, end) {
    for (var i=start; i<end && this[i]!==0; i++) {}
    return this.toString('utf-8', start, i);
}

function defaultBuffer(mac, len)  {
    if(len == undefined) len = 9;
    var body = new Buffer(len);
    body.fill(0);
    body.writeDoubleLE(mac, 0);
    return body;
}


var commands = [];
var seq = 0;
var client;

function create_command(cmd, body, flag) {

    if (flag == undefined && groupCommands.indexOf(cmd) >= 0) {
        for (var i = 1; i < 8 && body[i] == 0; i++);
        if (i==8) flag = 2;
    }

    var buffer = new Buffer(8 + body.length);
    buffer.fill(0);
    buffer.writeUInt16LE(8 + body.length - 2, 0);// length
    buffer.writeUInt8(flag || 0x00, 2);          // Flag, 0:node, 2:zone
    buffer.writeUInt8(cmd, 3);                   // command
    buffer.writeUInt32LE(++seq, 4);              // request id
    body.copy(buffer, 8);
    return {
        seq : seq,
        buffer : buffer,
        createTime : moment().format('x'),
        setprocesser : function(cb) {
            this.processer = cb;
            return this;
        }
    };
}

function defaultResponseCallback(data, pos) {
    return {
        mac : data.readDoubleLE(pos, 8),
        success : data.readUInt8(pos + 8)
    };
}


function sendCommand(cmdId, body, flag, cb) {
    if (typeof flag == 'function') { cb = flag; flag = 0; }
    if (cb == undefined) cb = defaultResponseCallback;
    return new Promise(function(resolve, reject) {
        var cmd = create_command(cmdId, body, flag)
            .setprocesser(function (_, data) {
                var fail = data.readUInt8(8);
                if(fail) {
                    return reject(fail);
                }
                var num = data.readUInt16LE(9);
                if (num == 0) return reject(0);
                var result = { result: [] };
                var statusLen = (data.length - 11) / num;
                for(var i = 0; i < num; i++) {
                    var pos = 11 + i * statusLen;
                    result.result.push(cb(data, pos));
                }
                if (__DEBUG__) {
                    result.request = cmd.buffer.toString('hex');
                    result.response = data.toString('hex');
                }
                resolve(result);
                return result;
            });
        commands.push(cmd);
        client.write(cmd.buffer);
    });
}


function start(ip, onError, debug) {
    if (debug != undefined) __DEBUG__ = debug;
    return new Promise(function(resolve, reject) {
        client = new net.Socket();
        var oTimeout;
        var connectTimer = setTimeout(function () {
            reject('timeout');
            client.destroy();
        }, 1000);
        client.on('data', function(data) {
            var seq = data.readUInt32LE(4);
            for(var i = 0; i < commands.length; i++) {
                if(commands[i].seq === seq) {
                    if(!commands[i].processer || !commands[i].processer(commands[i], data)) {
                        commands.splice(i, 1);
                    }
                    break;
                }
            }
        });

        client.on('error', function(error) {
            if(onError) {
                onError(error);
                return;
            }
            switch (error.errno) { //error.code
                case 'ETIMEDOUT':
                case 'ECONNRESET':
                case 'EPIPE':
                    if (oTimeout) clearTimeout(oTimeout);
                    oTimeout = setTimeout(function() {
                        client.destroy();
                        client.connect(4000, ip);
                    }, 3000);
                    break;
            };
        });
        client.connect(4000, ip, function() {
            clearTimeout(connectTimer);
            resolve();
        });
    });
}

function responseProcesser(data, status_len, single_result_cb) {
    var fail = data.readUInt8(8);
    if(fail) {
        return fail;
    }
    var num = data.readUInt16LE(9);
    results = [];
    for(var i = 0; i < num; i++) {
        var pos = 11 + i * status_len;
        results.push(single_result_cb(pos));
    }
    return results;
}


function successResponseProcesser(cmd, data) {
    var self = this;
    var result = responseProcesser(data, 9, function(pos) {
        return {
            mac : data.readDoubleLE(pos, 8),
            success : data.readUInt8(pos + 8)
        };
    });
    if(result instanceof Array) {
        self.resolve({
            result : result,
            request: cmd.buffer.toString('hex'),
            response: data.toString('hex')
        });
    } else {
        self.reject(result);
    }
}

var _devices = {};

function discovery() {
    return sendCommand(COMMAND_LIST_ALL_NODE, new Buffer([0x1]), function(data, pos) {
        var o = {
            id: data.readUInt16LE(pos),
            mac: data.readDoubleLE(pos + 2, 8),
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
        _devices[o.mac] = { type: o.type};
        return o;
    });
}

function zone_discovery() {
    return sendCommand(COMMAND_LIST_ALL_ZONE, new Buffer([0x0]), 2, function(data, pos) {
        return {
            id: data.readUInt16LE(pos),
            name: data.getOurUTF8String(pos + 2, pos + 18)
        };
    });
}

function node_on_off(mac, on) {
    var body = defaultBuffer(mac);
    body.writeUInt8(on ? 1 : 0, 8);
    return sendCommand(COMMAND_ONOFF, body);
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function node_soft_on_off(mac, on, transitiontime) {
    var body = defaultBuffer(mac, 10);
    body.writeUInt16LE(transitiontime || 0, 8);
    return sendCommand (on ? COMMAND_SOFT_ON : COMMAND_SOFT_OFF, body);
}


function activate_scene(sceneId) {
    var body = new Buffer(2);
    body.writeUInt8(sceneId, 0);
    body.writeUInt8(0, 1);
    return sendCommand (COMMAND_ACTIVATE_SCENE, body);
}

function get_zone_info(zone) {
    var body = new Buffer(2);
    body.writeUInt8(zone, 0);
    body.writeUInt8(0, 1);
    return sendCommand (COMMAND_GET_ZONE_INFO, body, 2, function(data, pos) {
        var o = {
            groupNo: data.readUInt8(9),
            name: data.getOurUTF8String(11, 26),
            devices: []
        }
        var cnt = data.readUInt8(27);
        for (var i=28; i<data.length; i+=8) {
            o.devices.push(data.readDoubleLE(i, 8));
        }
        return o;
    });
}

function get_status(mac) {
    var body = defaultBuffer(mac, 8);
    return sendCommand(COMMAND_GET_STATUS, body, function(data, pos) {
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
        if (_devices[o.mac]) o.type = _devices[o.mac].type;
        return o;
    });
}

function close() {
    if (client) {
        //client.close();
        client.destroy();
        client = null;
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

function node_brightness(mac, brightness, step_time) {
    var buffer = defaultBuffer(mac, 11);
    buffer.writeUInt8(brightness, 8);
    buffer.writeUInt16LE(step_time || 0, 9);
    return sendCommand(COMMAND_BRIGHTNESS, buffer);
}

function node_temperature(mac, temperature, step_time) {
    var buffer = defaultBuffer(mac, 12);
    buffer.writeUInt16LE(temperature, 8);
    buffer.writeUInt16LE(step_time || 0, 10);
    return sendCommand(COMMAND_TEMP, buffer);
}

function node_color(mac, red, green, blue, alpha, step_time) {
    var buffer = defaultBuffer(mac, 14);
    buffer.writeUInt8(red, 8);
    buffer.writeUInt8(green, 9);
    buffer.writeUInt8(blue, 10);
    buffer.writeUInt8(alpha, 11);
    buffer.writeUInt16LE(step_time || 0, 12);

    return sendCommand(COMMAND_COLOR, buffer);
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
    start: start,
    discovery : discovery,
    zone_discovery : zone_discovery,
    node_on_off : node_on_off,

    node_soft_on_off: node_soft_on_off,
    get_zone_info: get_zone_info,
    get_status: get_status,
    activate_scene: activate_scene,
    close: close,

    node_brightness : node_brightness,
    node_temperature : node_temperature,
    node_color : node_color,
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

