'use strict';

const utils            = require('@iobroker/adapter-core');
const adapterName      = (require('./package.json').name.split('.').pop() || '').toString();
const Nightscout       = require('./lib/nightscout');
const axios            = require('axios');
const crypto           = require('crypto');
const NightscoutClient = require('./lib/client');

let getImage;

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;
let URL;
let secret;
let client;

function readRoles() {
    const query = {
        url:     URL + '/api/v2/authorization/subjects',
        method:  'GET',
        headers: {'api-secret': secret}
    };

    return axios(query)
        .then(response => {
            const body = response.data;
            if (body) {
                const item = body.find(item => item.name === 'phantomjs');
                if (item) {
                    return item.accessToken;
                }
            }
            return null;
        });
}

function checkRole() {
    return readRoles()
        .then(accessToken => {
            if (accessToken) {
                return accessToken;
            } else {
                const query = {
                    url: URL + '/api/v2/authorization/subjects',
                    method: 'POST',
                    body: 'name=phantomjs&roles%5B%5D=readable&notes=',
                    headers: {
                        'api-secret': secret,
                        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
                    }
                };                    // add phantomjs
                return axios(query)
                    .then(response => {
                        const body = response.data;
                        if (body) {
                            return readRoles()
                                .catch(error => {
                                    throw new Error('Cannot get accessToken');
                                });
                        } else {
                            throw new Error('No body');
                        }
                    });
            }
        });
}

/**
 * Starts the adapter instance
 * @param {Partial<ioBroker.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: adapterName,

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: main, // Main method defined below for readability

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: callback => {
            adapter && adapter.setState && adapter.setState('info.connection', false, true);
            try {
                client && client.close();
                client = null;

                Nightscout.stopServer(callback);
            } catch (e) {
                callback();
            }
        },

        stateChange(id, state) {
            if (id.endsWith('trigger.picture') && state && state.ack === false && state.val) {
                adapter.getForeignObject('system.adapter.phantomjs.0', (err, obj) => {
                    if (!obj || !obj.common || !obj.common.enabled) {
                        adapter.log.error('PhantomJS is not installed or not enabled');
                    } else {
                        // check if phantomjs role exists
                        checkRole()
                            .then(token => {
                                adapter.sendTo('phantomjs.0', 'send', {
                                    url:                    URL + '/?token=' + token,
                                    output:                 'nightscout.png',  // default value
                                    width:                  800,            // default value
                                    height:                 600,            // default value
                                    timeout:                5000,           // default value
                                    zoom:                   1,              // default value

                                    'clip-top':             0,              // default value
                                    'clip-left':            0,              // default value
                                    'clip-width':           800,            // default value is equal to width
                                    'clip-height':          600,            // default value is equal to height
                                    'scroll-top':           0,              // default value
                                    'scroll-left':          0,              // default value

                                    online:                 true            // default value
                                }, result => {
                                    if (!result || result.error) {
                                        adapter.log.error('Cannot render website: ' + JSON.stringify(result && result.error));
                                        adapter.setState('trigger.picture', false, true);
                                    } else {
                                        adapter.setState('trigger.picture', true, true);
                                    }
                                    if (result && result.stderr) {
                                        adapter.log.error('Cannot render website: ' + result.stderr);
                                    }
                                    if (result && result.stdout) {
                                        adapter.log.debug('Nightscout rendered: ' + result.stdout);
                                    }
                                    adapter.log.debug('Nightscout rendered: ' + (result && result.output));
                                    adapter.log.debug('Picture can be find under phantomjs.0.pictures.nightscout_png');
                                });
                            })
                            .catch(e => {
                                adapter.setState('trigger.picture', false, true);
                                adapter.log.error('Cannot enable phantomjs: ' + e);
                            });
                    }
                });
            }
        },

        // Some message was sent to adapter instance over message box. Used by email, pushover, text2speech, ...
        // requires "common.message" property to be set to true in io-package.json
        message: obj => processMessage(obj),
    }));
}

function processMessage(obj) {
    if (typeof obj === 'object' && obj.message) {
        if (!obj.callback) {
            return;
        }
        if (obj.command === 'send') {
            // expected
            // {
            //       path: '/api/v1/status.json',
            //       method: 'GET',
            //       body: json,
            // }
            if (typeof obj.message === 'string') {
                try {
                    obj.message = JSON.parse(obj.message);
                } catch (e) {
                    return adapter.sendTo(obj.from, obj.command, {error: 'cannot parse message'}, obj.callback);
                }
            }

            const query = {
                url: URL + obj.message.path,
                method: (obj.message.method || 'GET').toUpperCase()
            };

            if (obj.message.body && typeof obj.message.body === 'string' && (obj.message.body[0] === '[' || obj.message.body[0] === '{')) {
                try {
                    obj.message.body = JSON.parse(obj.message.body);
                } catch (e) {
                    // ignore error and try to treat it as string
                }
            }

            const id = obj.message.id;

            query.headers = {
                'api-secret': secret,
                'accept': '*/*'
            };

            if (query.method !== 'GET') {
                if (typeof obj.message.body === 'object') {
                    query.json = obj.message.body;
                    query.headers['content-type'] = 'application/json';
                } else {
                    query.body = obj.message.body;
                }
            }

            query.url = query.url.replace(/secret=[^&]*/, 'secret=' + secret);

            adapter.log.debug('Request from IoT: ' + JSON.stringify(query));
            axios(query)
                .then(response => {
                    const body = response.data;
                    adapter.log.debug('Response to IoT: ' + JSON.stringify(body));
                    adapter.sendTo(obj.from, obj.command, id ? {id, body, 'content-type': state && state.headers && state.headers['content-type']} : body, obj.callback);
                });
        } else
        if (obj.command === 'chart') {
            // expected:
            // {
            //      from: timestamp // default now - 3 hours
            //      to:   timestamp // default now
            //      width: image width // default 720
            //      height: image width // default 480
            //      format: svg/png/jpg // default png
            // }
            const now = Date.now();

            const defaults = {
                start:  now - 3 * 3600000,
                end:    now,
                width:  720,
                height: 480,
                format: 'png',
                lang:   adapter.config.language
            };

            try {
                getImage = getImage || require('./lib/getImage');
            } catch (e) {
                return adapter.sendTo(obj.from, obj.command, {error: 'Cannot load getImage: ' + e}, obj.callback);
            }

            obj.message = Object.assign(defaults, obj.message || {});

            let host;
            if (adapter.config.local) {
                host = `http://${adapter.config.bind}:${adapter.config.port}`;
            } else {
                host = adapter.config.url;
            }

            const url = `${host}/api/v1/entries.json?find[date][$gte]=${new Date(obj.message.start).getTime()}&find[date][$lt]=${new Date(obj.message.end).getTime()}&count=10000`;

            axios(url, { headers: { 'api-secret': secret }})
                .then(response => {
                    const body = response.data;
                    if (body) {
                        return getImage(body, obj.message)
                            .then(image => adapter.sendTo(obj.from, obj.command, { result: image }, obj.callback))
                            .catch(error => adapter.sendTo(obj.from, obj.command, { error }, obj.callback));
                    } else {
                        adapter.sendTo(obj.from, obj.command, { error: 'No body' }, obj.callback);
                    }
                })
                .catch(error => adapter.sendTo(obj.from, obj.command, { error: 'Cannot fetch data: ' + error}, obj.callback));
        }
    }
}

function start() {
    if (adapter.config.local) {
        if (!adapter.config.language) {
            adapter.getForeignObject('system.config', (err, obj) => {
                adapter.config.language = (obj && obj.common && obj.common.language) || 'en';
                Nightscout.startServer(adapter)
                    .then(() =>
                        setTimeout(() => {
                            client = new NightscoutClient(adapter, URL, secret);
                            client.on('connection', connected => adapter.setState('info.connection', connected, true));
                        }, 1000));
            });
        } else {
            Nightscout.startServer(adapter).then(() =>
                setTimeout(() => {
                    client = new NightscoutClient(adapter, URL, secret);
                    client.on('connection', connected => adapter.setState('info.connection', connected, true));
                }, 1000));
        }
    } else {
        client = new NightscoutClient(adapter, URL, secret);
        client.on('connection', connected => adapter.setState('info.connection', connected, true));
    }
}

function main() {
    adapter.setState('info.connection', false, true);
    const shasum = crypto.createHash('sha1');
    if (adapter.config.local) {
        if (adapter.config.secret) {
            secret = shasum.update(adapter.config.secret).digest('hex');
        } else {
            secret = '';
        }
    } else {
        if (adapter.config.remoteSecret) {
            secret = shasum.update(adapter.config.remoteSecret).digest('hex');
        } else {
            secret = '';
        }
    }

    adapter.getForeignObject('system.config', (err, obj) => {
        if (!obj || !obj.common || !obj.common.defaultHistory) {
            adapter.log.warn('No default history selected, so charts will not work');
        } else {
            adapter.__defaultHistory = obj.common.defaultHistory;
        }
    });

    if (adapter.config.local) {
        URL = `http${adapter.config.secure ? 's' : ''}://${adapter.config.bind}:${adapter.config.port}`;
    } else {
        URL = adapter.config.url;
    }

    adapter.subscribeStates('trigger.picture');

    if (!adapter.config.licenseAccepted) {
        adapter.log.warn('Please go to configuration page and read disclaimer');
        return;
    }

    if (adapter.config.secure) {
        // Load certificates
        adapter.getCertificates((err, certificates, leConfig) => {
            adapter.config.certificates = certificates;
            adapter.config.leConfig     = leConfig;
            start();
        });
    } else {
        start();
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}
