var net = require('net');
var moment = require('moment');
var Promise = require('promise');

var COMMAND_ALL_LIGHT_STATUS = 0x13;
var COMMAND_BRIGHTNESS = 0x31;
var COMMAND_ONOFF = 0x32;
var COMMAND_TEMP = 0x33;
var COMMAND_COLOR = 0x36;


var commands = [];
var lights = [];


var seq = 0;
var client;
function create_command(cmd, body) {
    var buffer = new Buffer(8 + body.length);
    buffer.fill(0);
    buffer.writeUInt16LE(8 + body.length - 2, 0);// length
    buffer.writeUInt8(0x00, 2); // Flag, 0:node, 2:zone
    buffer.writeUInt8(cmd, 3);
    buffer.writeUInt32LE(++seq, 4); // request id
    body.copy(buffer, 8);
    return {
        seq,
        buffer,
        createTime : moment().format('x'),
        setprocesser : function(cb) {
            this.processer = cb;
            return this;
        }
    };
}


function start(ip) {
    client = new net.Socket();
    var left_over = '';
    client.on('data', (data) => {
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
    return new Promise(function(resolve, reject) {
        client.connect(4000, ip, function () {
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
    var lights = responseProcesser(data, 9, function(pos) {
        return {
            mac : data.readDoubleLE(pos, 8),
            success : data.readUInt8(pos + 8)
        };
    });
    if(lights instanceof Array) {
        self.resolve({
            lights,
            request: cmd.buffer.toString('hex'),
            response: data.toString('hex')
        });
    } else {
        self.reject(lights);
    }
}
function discovery() {
    return new Promise(function(resolve, reject) {
        var cmd = create_command(COMMAND_ALL_LIGHT_STATUS, new Buffer([0x1]))
        .setprocesser(function(_, data) {
            lights = responseProcesser(data, 50, function(pos) {
                for(var j = pos + 26; j < pos + 50; j++) {
                    if(data[j] === 0){
                        break;
                    }
                }
                return {
                    id : data.readUInt16LE(pos),
                    mac : data.readDoubleLE(pos + 2, 8),
                    type : data.readUInt8(pos + 10),
                    firmware_version : data.readUInt32BE(pos + 11),
                    online : data.readUInt8(pos + 15),
                    groupid : data.readUInt16LE(pos + 16),
                    status : data.readUInt8(pos + 18), // 0 == off, 1 == on
                    brightness : data.readUInt8(pos + 19),
                    temperature : data.readUInt16LE(pos + 20),
                    red : data.readUInt8(pos + 22),
                    green : data.readUInt8(pos + 23),
                    blue : data.readUInt8(pos + 24),
                    alpha : data.readUInt8(pos + 25),
                    name : data.toString('utf-8', pos + 26, j)
                };
                
            });
            if(lights instanceof Array) {
                resolve({
                    lights,
                    request: cmd.buffer.toString('hex'),
                    response: data.toString('hex')
                });
            } else {
                reject(lights);
            }
        });
        commands.push(cmd);
        client.write(cmd.buffer);
    });
}

function light_on_off(mac, on) {
    return new Promise(function(resolve, reject) {
        var body = new Buffer(9);
        body.fill(0);
        body.writeDoubleLE(mac, 0);
        body.writeUInt8(on ? 1 : 0, 8);
        var cmd = create_command(COMMAND_ONOFF, body)
            .setprocesser(successResponseProcesser.bind({resolve, reject}));

        commands.push(cmd);
        client.write(cmd.buffer);
    });
}

function light_brightness(mac, brightness, step_time, log) {
    return new Promise(function(resolve, reject) {
        var buffer = new Buffer(11);
        buffer.fill(0);
        buffer.writeDoubleLE(mac, 0);
        buffer.writeUInt8(brightness, 8);
        buffer.writeUInt16LE(step_time || 0, 9);
        var cmd = create_command(COMMAND_BRIGHTNESS, buffer)
            .setprocesser(successResponseProcesser.bind({resolve, reject}));
        commands.push(cmd);
        client.write(cmd.buffer);
    });
}

function light_temperature(mac, temperature, step_time, log) {
    return new Promise(function(resolve, reject) {
        var buffer = new Buffer(12);
        buffer.fill(0);
        buffer.writeDoubleLE(mac, 0);
        buffer.writeUInt16LE(temperature, 8);
        buffer.writeUInt16LE(step_time || 0, 10);
        var cmd = create_command(COMMAND_TEMP, buffer)
            .setprocesser(successResponseProcesser.bind({resolve, reject}));
        commands.push(cmd);
        client.write(cmd.buffer);
    });
}

function light_color(mac, red, green, blue, alpha, step_time, log) {
    return new Promise(function(resolve, reject) {
        var buffer = new Buffer(14);
        buffer.fill(0);
        buffer.writeDoubleLE(mac, 0);
        buffer.writeUInt8(red, 8);
        buffer.writeUInt8(green, 9);
        buffer.writeUInt8(blue, 10);
        buffer.writeUInt8(alpha, 11);
        buffer.writeUInt16LE(step_time || 0, 12);
        var cmd = create_command(COMMAND_COLOR, buffer)
            .setprocesser(successResponseProcesser.bind({resolve, reject}));
        commands.push(cmd);
        client.write(cmd.buffer);
    });
}

function isPlug(type) {
    return type === 16;
}
function getLightType(type) {
    return isPlug(type) ? 16 : type;
}
function isSwitch(type) {
    return type === 64 || type === 65;
}
var exports = module.exports = {
    start,
    discovery,
    light_on_off,
    light_brightness,
    isPlug,
    isSwitch,
    is2BSwitch : function(type) { return type === 64;},
    is4BSwitch : function(type) { return type === 65;},
    isBrightnessSupported : function(type) { return getLightType(type) === 2 || getLightType(type) === 4 || (getLightType(type) != 16 && getLightType(type) != 1);},
    isColorSupported : function(type) { return getLightType(type) === 10 || getLightType(type) === 8; },
    isLight : function(type) { return !isSwitch(type) && !isPlug(type); },
    isTemperatureSupported : function(type) {return getLightType(type) === 2 || getLightType(type) === 10; }
};