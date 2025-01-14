/*@flow*/
/* jshint esversion: 6 */
/* global Buffer */
var Fs = require("fs");
var Fse = require("fs-extra");
var Path = require("path");
var nThen = require("nthen");
var Semaphore = require("saferphore");
const ToPull = require('stream-to-pull-stream');
const Pull = require('pull-stream');

const isValidChannelId = function (id) {
    return typeof(id) === 'string' &&
        id.length >= 32 && id.length < 50 &&
        /^[a-zA-Z0-9=+-]*$/.test(id);
};

// 511 -> octal 777
// read, write, execute permissions flag
const PERMISSIVE = 511;

var mkPath = function (env, channelId) {
    return Path.join(env.root, channelId.slice(0, 2), channelId) + '.ndjson';
};

var mkArchivePath = function (env, channelId) {
    return Path.join(env.archiveRoot, 'datastore', channelId.slice(0, 2), channelId) + '.ndjson';
};

var getMetadataAtPath = function (Env, path, cb) {
    var remainder = '';
    var stream = Fs.createReadStream(path, { encoding: 'utf8' });
    var complete = function (err, data) {
        var _cb = cb;
        cb = undefined;
        if (_cb) { _cb(err, data); }
    };
    stream.on('data', function (chunk) {
        if (!/\n/.test(chunk)) {
            remainder += chunk;
            return;
        }
        stream.close();
        var metadata = chunk.split('\n')[0];

        var parsed = null;
        try {
            parsed = JSON.parse(metadata);
            complete(undefined, parsed);
        }
        catch (e) {
            console.log("getMetadataAtPath");
            console.error(e);
            complete('INVALID_METADATA');
        }
    });
    stream.on('end', function () {
        complete();
    });
    stream.on('error', function (e) { complete(e); });
};

var getChannelMetadata = function (Env, channelId, cb) {
    var path = mkPath(Env, channelId);
    getMetadataAtPath(Env, path, cb);
};

var closeChannel = function (env, channelName, cb) {
    if (!env.channels[channelName]) { return void cb(); }
    try {
        env.channels[channelName].writeStream.close();
        delete env.channels[channelName];
        env.openFiles--;
        cb();
    } catch (err) {
        cb(err);
    }
};

var clearChannel = function (env, channelId, cb) {
    var path = mkPath(env, channelId);
    getMetadataAtPath(env, path, function (e, metadata) {
        if (e) { return cb(new Error(e)); }
        if (!metadata) {
            return void Fs.truncate(path, 0, function (err) {
                if (err) {
                    return cb(err);
                }
                cb(void 0);
            });
        }

        var len = JSON.stringify(metadata).length + 1;

        // as long as closeChannel is synchronous, this should not cause
        // any race conditions. truncate ought to return faster than a channel
        // can be opened and read by another user. if that turns out not to be
        // the case, we'll need to implement locking.
        closeChannel(env, channelId, function (err) {
            if (err) { cb(err); }
            Fs.truncate(path, len, function (err) {
                if (err) { return cb(err); }
                cb();
            });
        });
    });
};

var readMessages = function (path, msgHandler, cb) {
    var remainder = '';
    var stream = Fs.createReadStream(path, { encoding: 'utf8' });
    var complete = function (err) {
        var _cb = cb;
        cb = undefined;
        if (_cb) { _cb(err); }
    };
    stream.on('data', function (chunk) {
        var lines = chunk.split('\n');
        lines[0] = remainder + lines[0];
        remainder = lines.pop();
        lines.forEach(msgHandler);
    });
    stream.on('end', function () {
        msgHandler(remainder);
        complete();
    });
    stream.on('error', function (e) { complete(e); });
};

const NEWLINE_CHR = ('\n').charCodeAt(0);
const mkBufferSplit = () => {
    let remainder = null;
    return Pull((read) => {
        return (abort, cb) => {
            read(abort, function (end, data) {
                if (end) {
                    if (data) { console.log("mkBufferSplit() Data at the end"); }
                    cb(end, remainder ? [remainder, data] : [data]);
                    remainder = null;
                    return;
                }
                const queue = [];
                for (;;) {
                    const offset = data.indexOf(NEWLINE_CHR);
                    if (offset < 0) {
                        remainder = remainder ? Buffer.concat([remainder, data]) : data;
                        break;
                    }
                    let subArray = data.slice(0, offset);
                    if (remainder) {
                        subArray = Buffer.concat([remainder, subArray]);
                        remainder = null;
                    }
                    queue.push(subArray);
                    data = data.slice(offset + 1);
                }
                cb(end, queue);
            });
        };
    }, Pull.flatten());
};

const mkOffsetCounter = () => {
    let offset = 0;
    return Pull.map((buff) => {
        const out = { offset: offset, buff: buff };
        // +1 for the eaten newline
        offset += buff.length + 1;
        return out;
    });
};

const readMessagesBin = (env, id, start, msgHandler, cb) => {
    const stream = Fs.createReadStream(mkPath(env, id), { start: start });
    // TODO get the channel and add the atime
    let keepReading = true;
    Pull(
        ToPull.read(stream),
        mkBufferSplit(),
        mkOffsetCounter(),
        Pull.asyncMap((data, moreCb) => {
            msgHandler(data, moreCb, () => { keepReading = false; moreCb(); });
        }),
        Pull.drain(() => (keepReading), (err) => {
            cb((keepReading) ? err : undefined);
        })
    );
};

var checkPath = function (path, callback) {
    // TODO check if we actually need to use stat at all
    Fs.stat(path, function (err) {
        if (!err) {
            callback(undefined, true);
            return;
        }
        if (err.code !== 'ENOENT') {
            callback(err);
            return;
        }
        Fse.mkdirp(Path.dirname(path), PERMISSIVE, function (err) {
            if (err && err.code !== 'EEXIST') {
                callback(err);
                return;
            }
            callback(undefined, false);
        });
    });
};

var removeChannel = function (env, channelName, cb) {
    var filename = mkPath(env, channelName);
    Fs.unlink(filename, cb);
};

// pass in the path so we can reuse the same function for archived files
var channelExists = function (filepath, channelName, cb) {
    Fs.stat(filepath, function (err, stat) {
        if (err) {
            if (err.code === 'ENOENT') {
                // no, the file doesn't exist
                return void cb(void 0, false);
            }
            return void cb(err);
        }
        if (!stat.isFile()) { return void cb("E_NOT_FILE"); }
        return void cb(void 0, true);
    });
};

var removeArchivedChannel = function (env, channelName, cb) {
    var filename = mkArchivePath(env, channelName);
    Fs.unlink(filename, cb);
};

var listChannels = function (root, handler, cb) {
    // do twenty things at a time
    var sema = Semaphore.create(20);

    var dirList = [];

    nThen(function (w) {
        // the root of your datastore contains nested directories...
        Fs.readdir(root, w(function (err, list) {
            if (err) {
                w.abort();
                // TODO check if we normally return strings or errors
                return void cb(err);
            }
            dirList = list;
        }));
    }).nThen(function (w) {
        // search inside the nested directories
        // stream it so you don't put unnecessary data in memory
        var wait = w();
        dirList.forEach(function (dir) {
            sema.take(function (give) {
                var nestedDirPath = Path.join(root, dir);
                Fs.readdir(nestedDirPath, w(give(function (err, list) {
                    if (err) { return void handler(err); } // Is this correct?

                    list.forEach(function (item) {
                        // ignore things that don't match the naming pattern
                        if (/^\./.test(item) || !/[0-9a-fA-F]{32,}\.ndjson$/.test(item)) { return; }
                        var filepath = Path.join(nestedDirPath, item);
                        var channel = filepath.replace(/\.ndjson$/, '').replace(/.*\//, '');
                        if ([32, 34].indexOf(channel.length) === -1) { return; }

                        // otherwise throw it on the pile
                        sema.take(function (give) {
                            var next = w(give());
                            Fs.stat(filepath, w(function (err, stats) {
                                if (err) {
                                    return void handler(err);
                                }

                                handler(void 0, {
                                    channel: channel,
                                    atime: stats.atime,
                                    mtime: stats.mtime,
                                    ctime: stats.ctime,
                                    size: stats.size,
                                }, next);
                            }));
                        });
                    });
                })));
            });
        });
        wait();
    }).nThen(function () {
        cb();
    });
};

// move a channel's log file from its current location
// to an equivalent location in the cold storage directory
var archiveChannel = function (env, channelName, cb) {
    if (!env.retainData) {
        return void cb("ARCHIVES_DISABLED");
    }

    // ctime is the most reliable indicator of when a file was archived
    // because it is used to indicate changes to the files metadata
    // and not its contents
    // if we find that this is not reliable in production, we can update it manually
    // https://nodejs.org/api/fs.html#fs_fs_utimes_path_atime_mtime_callback

    // check what the channel's path should be (in its current location)
    var currentPath = mkPath(env, channelName);

    // construct a parallel path in the new location
    var archivePath = mkArchivePath(env, channelName);

    // use Fse.move to move it, Fse makes paths to the directory when you use it.
    // https://github.com/jprichardson/node-fs-extra/blob/HEAD/docs/move.md
    Fse.move(currentPath, archivePath, { overwrite: true }, cb);
};

var unarchiveChannel = function (env, channelName, cb) {
    // very much like 'archiveChannel' but in the opposite direction

    // the file is currently archived
    var currentPath = mkArchivePath(env, channelName);
    var unarchivedPath = mkPath(env, channelName);

    // if a file exists in the unarchived path, you probably don't want to clobber its data
    // so unlike 'archiveChannel' we won't overwrite.
    // Fse.move will call back with EEXIST in such a situation
    Fse.move(currentPath, unarchivedPath, cb);
};

var flushUnusedChannels = function (env, cb, frame) {
    var currentTime = +new Date();

    var expiration = typeof(frame) === 'undefined'?  env.channelExpirationMs: frame;
    Object.keys(env.channels).forEach(function (chanId) {
        var chan = env.channels[chanId];
        if (typeof(chan.atime) !== 'number') { return; }
        if (currentTime >= expiration + chan.atime) {
            closeChannel(env, chanId, function (err) {
                if (err) {
                    console.error(err);
                    return;
                }
                if (env.verbose) {
                    console.log("Closed channel [%s]", chanId);
                }
            });
        }
    });
    cb();
};

var channelBytes = function (env, chanName, cb) {
    var path = mkPath(env, chanName);
    Fs.stat(path, function (err, stats) {
        if (err) { return void cb(err); }
        cb(undefined, stats.size);
    });
};

/*::
export type ChainPadServer_ChannelInternal_t = {
    atime: number,
    writeStream: typeof(process.stdout),
    whenLoaded: ?Array<(err:?Error, chan:?ChainPadServer_ChannelInternal_t)=>void>,
    onError: Array<(?Error)=>void>,
    path: string
};
*/
var getChannel = function (
    env,
    id,
    callback /*:(err:?Error, chan:?ChainPadServer_ChannelInternal_t)=>void*/
) {
    if (env.channels[id]) {
        var chan = env.channels[id];
        chan.atime = +new Date();
        if (chan.whenLoaded) {
            chan.whenLoaded.push(callback);
        } else {
            callback(undefined, chan);
        }
        return;
    }

    if (env.openFiles >= env.openFileLimit) {
        // if you're running out of open files, asynchronously clean up expired files
        // do it on a shorter timeframe, though (half of normal)
        setTimeout(function () {
            flushUnusedChannels(env, function () {
                if (env.verbose) {
                    console.log("Approaching open file descriptor limit. Cleaning up");
                }
            }, env.channelExpirationMs / 2);
        });
    }
    var path = mkPath(env, id);
    var channel /*:ChainPadServer_ChannelInternal_t*/ = env.channels[id] = {
        atime: +new Date(),
        writeStream: (undefined /*:any*/),
        whenLoaded: [ callback ],
        onError: [ ],
        path: path
    };
    var complete = function (err) {
        var whenLoaded = channel.whenLoaded;
        // no guarantee stream.on('error') will not cause this to be called multiple times
        if (!whenLoaded) { return; }
        channel.whenLoaded = undefined;
        if (err) {
            delete env.channels[id];
        }
        if (!channel.writeStream) {
            throw new Error("getChannel() complete called without channel writeStream");
        }
        whenLoaded.forEach(function (wl) { wl(err, (err) ? undefined : channel); });
    };
    var fileExists;
    var errorState;
    nThen(function (waitFor) {
        checkPath(path, waitFor(function (err, exists) {
            if (err) {
                errorState = true;
                complete(err);
                return;
            }
            fileExists = exists;
        }));
    }).nThen(function (waitFor) {
        if (errorState) { return; }
        var stream = channel.writeStream = Fs.createWriteStream(path, { flags: 'a' });
        env.openFiles++;
        stream.on('open', waitFor());
        stream.on('error', function (err /*:?Error*/) {
            env.openFiles--;
            // this might be called after this nThen block closes.
            if (channel.whenLoaded) {
                complete(err);
            } else {
                channel.onError.forEach(function (handler) {
                    handler(err);
                });
            }
        });
    }).nThen(function () {
        if (errorState) { return; }
        complete();
    });
};

const messageBin = (env, chanName, msgBin, cb) => {
    getChannel(env, chanName, function (err, chan) {
        if (!chan) {
            cb(err);
            return;
        }
        let called = false;
        var complete = function (err) {
            if (called) { return; }
            called = true;
            cb(err);
        };
        chan.onError.push(complete);
        chan.writeStream.write(msgBin, function () {
            /*::if (!chan) { throw new Error("Flow unreachable"); }*/
            chan.onError.splice(chan.onError.indexOf(complete), 1);
            if (!cb) { return; }
            //chan.messages.push(msg);
            chan.atime = +new Date(); // FIXME seems like odd behaviour that not passing a callback would result in not updating atime...
            complete();
        });
    });
};

var message = function (env, chanName, msg, cb) {
    messageBin(env, chanName, new Buffer(msg + '\n', 'utf8'), cb);
};

var getMessages = function (env, chanName, handler, cb) {
    getChannel(env, chanName, function (err, chan) {
        if (!chan) {
            cb(err);
            return;
        }
        var errorState = false;
        readMessages(chan.path, function (msg) {
            if (!msg || errorState) { return; }
            //console.log(msg);
            try {
                handler(msg);
            } catch (e) {
                errorState = true;
                return void cb(err);
            }
        }, function (err) {
            if (err) {
                errorState = true;
                return void cb(err);
            }
            if (!chan) { throw new Error("impossible, flow checking"); }
            chan.atime = +new Date();
            cb();
        });
    });
};

/*::
export type ChainPadServer_MessageObj_t = { buff: Buffer, offset: number };
export type ChainPadServer_Storage_t = {
    readMessagesBin: (
        channelName:string,
        start:number,
        asyncMsgHandler:(msg:ChainPadServer_MessageObj_t, moreCb:()=>void, abortCb:()=>void)=>void,
        cb:(err:?Error)=>void
    )=>void,
    message: (channelName:string, content:string, cb:(err:?Error)=>void)=>void,
    messageBin: (channelName:string, content:Buffer, cb:(err:?Error)=>void)=>void,
    getMessages: (channelName:string, msgHandler:(msg:string)=>void, cb:(err:?Error)=>void)=>void,
    removeChannel: (channelName:string, cb:(err:?Error)=>void)=>void,
    closeChannel: (channelName:string, cb:(err:?Error)=>void)=>void,
    flushUnusedChannels: (cb:()=>void)=>void,
    getChannelSize: (channelName:string, cb:(err:?Error, size:?number)=>void)=>void,
    getChannelMetadata: (channelName:string, cb:(err:?Error|string, data:?any)=>void)=>void,
    clearChannel: (channelName:string, (err:?Error)=>void)=>void
};
export type ChainPadServer_Config_t = {
    verbose?: boolean,
    filePath?: string,
    channelExpirationMs?: number,
    openFileLimit?: number
};
*/
module.exports.create = function (
    conf /*:ChainPadServer_Config_t*/,
    cb /*:(store:ChainPadServer_Storage_t)=>void*/
) {
    var env = {
        root: conf.filePath || './datastore',
        archiveRoot: conf.archivePath || './data/archive',
        retainData: conf.retainData,
        channels: { },
        channelExpirationMs: conf.channelExpirationMs || 30000,
        verbose: conf.verbose,
        openFiles: 0,
        openFileLimit: conf.openFileLimit || 2048,
    };
    var it;

    nThen(function (w) {
        // make sure the store's directory exists
        Fse.mkdirp(env.root, PERMISSIVE, w(function (err) {
            if (err && err.code !== 'EEXIST') {
                throw err;
            }
        }));
        // make sure the cold storage directory exists
        Fse.mkdirp(env.archiveRoot, PERMISSIVE, w(function (err) {
            if (err && err.code !== 'EEXIST') {
                throw err;
            }
        }));
    }).nThen(function () {
        cb({
            readMessagesBin: (channelName, start, asyncMsgHandler, cb) => {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                readMessagesBin(env, channelName, start, asyncMsgHandler, cb);
            },
            message: function (channelName, content, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                message(env, channelName, content, cb);
            },
            messageBin: (channelName, content, cb) => {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                messageBin(env, channelName, content, cb);
            },
            getMessages: function (channelName, msgHandler, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                getMessages(env, channelName, msgHandler, cb);
            },
            removeChannel: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                removeChannel(env, channelName, function (err) {
                    cb(err);
                });
            },
            removeArchivedChannel: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                removeArchivedChannel(env, channelName, cb);
            },
            closeChannel: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                closeChannel(env, channelName, cb);
            },
            flushUnusedChannels: function (cb) {
                flushUnusedChannels(env, cb);
            },
            getChannelSize: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                channelBytes(env, channelName, cb);
            },
            getChannelMetadata: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                getChannelMetadata(env, channelName, cb);
            },
            clearChannel: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                clearChannel(env, channelName, cb);
            },
            listChannels: function (handler, cb) {
                listChannels(env.root, handler, cb);
            },
            isChannelAvailable: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                // construct the path
                var filepath = mkPath(env, channelName);
                channelExists(filepath, channelName, cb);
            },
            isChannelArchived: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                // construct the path
                var filepath = mkArchivePath(env, channelName);
                channelExists(filepath, channelName, cb);
            },
            listArchivedChannels: function (handler, cb) {
                listChannels(Path.join(env.archiveRoot, 'datastore'), handler, cb);
            },
            archiveChannel: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                archiveChannel(env, channelName, cb);
            },
            restoreArchivedChannel: function (channelName, cb) {
                if (!isValidChannelId(channelName)) { return void cb(new Error('EINVAL')); }
                unarchiveChannel(env, channelName, cb);
            },
            log: function (channelName, content, cb) {
                message(env, channelName, content, cb);
            },
            shutdown: function () {
                clearInterval(it);
            }
        });
    });
    it = setInterval(function () {
        flushUnusedChannels(env, function () { });
    }, 5000);
};
