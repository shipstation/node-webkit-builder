var Promise = require('bluebird');
var _ = require('lodash');
var inherits = require('inherits');
var EventEmitter = require('events').EventEmitter;
var fs = require('fs-extra');
var path = require('path');
var url = require('url');
var winresourcer = Promise.promisify(require('winresourcer'));
var spawn = require('child_process').spawn;
var semver = require('semver');
var platformOverrides = require('platform-overrides');
var detectCurrentPlatform = require('./detectCurrentPlatform.js')

var NwVersions = require('./versions');
var Utils = require('./utils');
var Downloader = require('./downloader');
var platforms = require('./platforms');

// We inherit from EventEmitter for logging
inherits(NwBuilder, EventEmitter);
module.exports = NwBuilder;
function NwBuilder(options) {
    var self = this;
    var defaults = {
        files: null,
        appName: false,
        appVersion: false,
        platforms: ['win','osx'],
        currentPlatform: detectCurrentPlatform(),
        version: 'latest',
        buildDir: './build',
        cacheDir: './cache',
        downloadUrl: 'http://dl.nwjs.io/',
        buildType: 'default',
        forceDownload: false,
        macCredits: false,
        macIcns: false,
        macZip: false,
        macPlist: false,
        winIco: null,
        winExe: true,
        argv: process.argv.slice(2)
    };

    // Assing options
    this.options = _.defaults(options, defaults);
    this._platforms = platforms;

    // Some Option checking
    if(!this.options.files) {
        throw new Error('Please specify some files');
    }

    if (this.options.platforms.length === 0)
        throw new Error('No platform to build!');

    // verify all the platforms specifed by the user are supported
    // this + previous check assures as we have only buildable platforms specified
    this.options.platforms.forEach(function(platform) {
        if (!(platform in platforms))
            throw new Error('unknown platform ' + platform)
    })

    this._platforms = _.cloneDeep(platforms)

    // clear all unused platforms
    for (var name in this._platforms) {
        if (this.options.platforms.indexOf(name) === -1)
            delete this._platforms[name]
    }
};

NwBuilder.prototype.build = function (callback) {
    var hasCallback = (typeof callback === 'function'),
        done = Promise.defer();

    // Let's create a node Webkit app
    this.checkFiles().bind(this)
        .then(this.resolveLatestVersion)
        .then(this.checkVersion)
        .then(this.platformFilesForVersion)
        .then(this.downloadNodeWebkit)
        .then(this.preparePlatformSpecificManifests)
        .then(this.createReleaseFolder)
        .then(this.copyNodeWebkit)
        .then(this.handleMacApp)
        .then(this.handleWinApp)
        .then(this.zipAppFiles)
        .then(this.mergeAppFiles)
        .then(function (info) {
            if(hasCallback) {
                callback(false, info);
            } else {
                done.resolve(info);
            }
        })
        .catch(function (error) {
            if(hasCallback) {
                callback(error);
            } else {
                done.reject(error);
            }
        });

    return hasCallback ? true : done.promise;
};

NwBuilder.prototype.run = function (callback) {
    var hasCallback = (typeof callback === 'function'),
        done = Promise.defer();

    // Let's run this node Webkit app
    this.checkFiles().bind(this)
        .then(this.resolveLatestVersion)
        .then(this.checkVersion)
        .then(this.platformFilesForVersion)
        .then(this.downloadNodeWebkit)
        .then(this.runApp)
        .then(function (info) {
            if(hasCallback) {
                callback(false, info);
            } else {
                done.resolve(info);
            }
        })
        .catch(function (error) {
            if(hasCallback) {
                callback(true, error);
            } else {
                done.reject(error);
            }
        });

    return hasCallback ? true : done.promise;
};


NwBuilder.prototype.checkFiles = function () {
    var self = this;

    return Utils.getFileList(this.options.files).then(function (data) {

        self._appPkg = data.json;
        self._files = data.files;

        return Utils.getPackageInfo(self._appPkg).then(function (appPkg) {
            self._appPkg = appPkg;

            if(!self.options.appName || self.options.appVersion) {
                self.options.appName = (self.options.appName ? self.options.appName : appPkg.name);
                self.options.appVersion = (self.options.appVersion ? self.options.appVersion : appPkg.version);
            }
        });
    });

};

NwBuilder.prototype.resolveLatestVersion = function () {
    var self = this;

    if(self.options.version !== 'latest') return Promise.resolve();

    return NwVersions.getLatestVersion(self.options.downloadUrl).then(function(latestVersion){
        self.emit('log', 'Latest Version: v' + latestVersion);
        self.options.version = latestVersion;
    });
};

NwBuilder.prototype.checkVersion = function () {
    var version = this.options.version.replace('v', '');

    if(!semver.valid(this.options.version)){
        return Promise.reject('The version ' + this.options.version + ' is not valid.');
    } else {
        this._version = NwVersions.getVersionNames( version );
        this.emit('log', 'Using v' + this._version.version);
    }

    return Promise.resolve();
};

NwBuilder.prototype.platformFilesForVersion = function () {
    var self = this;

    this._forEachPlatform(function (name, platform) {

        var satisfied = !Object.keys(platform.files).every(function(range) {
            if (semver.satisfies(self._version.version, range)) {
                platform.files = platform.files[range];
                return false;
            }
            return true;
        });

        if (!satisfied) {
            throw new Error("Unsupported node-webkit version '" + self._version.version + "' for platform '" + platform.type + "'");
        }
    });

    return true;
};

NwBuilder.prototype.downloadNodeWebkit = function () {
    var self = this,
        downloads = [];

    this._forEachPlatform(function (name, platform) {
        platform.cache = path.resolve(self.options.cacheDir, self._version.version, name);
        platform.url = url.resolve(self.options.downloadUrl, self._version.platforms[name]);

        // Ensure that there is a cache folder
        if(self.options.forceDownload) {
            fs.removeSync(platform.cache);
        }

        fs.mkdirpSync(platform.cache);
        self.emit('log', 'Create cache folder in ' + path.resolve(self.options.cacheDir, self._version.version));

        if(!Downloader.checkCache(platform.cache, platform.files)) {
            downloads.push(
                Downloader.downloadAndUnpack(platform.cache, platform.url)
                    .catch(function(err){
                        if(err.statusCode === 404){
                            self.emit('log', 'ERROR: The version '+self._version.version+' does not have a corresponding build posted at http://dl.node-webkit.org/. Please choose a version from that list.')
                        } else {
                            self.emit('log', err.msg)
                        }

                        return Promise.reject('Unable to download nodewebkit.');
                    })
            );
            self.emit('log', 'Downloading: ' + platform.url);
        } else {
            self.emit('log', 'Using cache for: ' + name);
        }
    });

    return Promise.all(downloads)
        .then(function(data) {
            Downloader.clearProgressbar();
            return data;
        });
};

NwBuilder.prototype.buildGypModules = function () {
    // @todo
    // If we trigger a rebuild we have to copy
    // the node_modules to a tmp location because
    // we don't want to change the source files

};


NwBuilder.prototype.preparePlatformSpecificManifests = function(){

    if(!(this._appPkg.platformOverrides && Object.keys(this._appPkg.platformOverrides).length)){
        return true;
    }

    var self = this;

    this._forEachPlatform(function (name, platform) {

        var overrides = self._appPkg.platformOverrides[name];
        if (overrides && Object.keys(overrides).length) {

            platformOverrides({
                options: self._appPkg,
                objectMode: true,
                platform: name
            }, function(err, result){
                 if(err) throw(err);
                 platform.platformSpecificManifest = result;
             });
        }
    });
};


NwBuilder.prototype.createReleaseFolder = function () {
    var self = this,
        releasePath;

    if (_.isFunction(self.options.buildType)) {
        releasePath = self.options.buildType.call(self.options);
    } else {
        // buildTypes
        switch(self.options.buildType) {
            case 'timestamped':
                releasePath = self.options.appName + ' - ' + Math.round(Date.now() / 1000).toString();
                break;

            case 'versioned':
                releasePath = self.options.appName + ' - v' + self.options.appVersion;
                break;

            default:
                releasePath = self.options.appName;
        }
    }

    this._forEachPlatform(function (name, platform) {
        platform.releasePath = path.resolve(self.options.buildDir, releasePath, name);

        // Ensure that there is a release Folder, delete and create it.
        fs.removeSync(platform.releasePath);
        fs.mkdirpSync(platform.releasePath);
        self.emit('log', 'Create release folder in ' + platform.releasePath);
    });

    return true;
};

NwBuilder.prototype.copyNodeWebkit = function () {
    var self = this,
        copiedFiles = [];

    this._forEachPlatform(function (name, platform) {
        var executable = platform.runable.split('/')[0];
        platform.files.forEach(function (file, i) {
            var destFile = file;
            if(i===0) {
                // rename executable to app name
                destFile = self.options.appName + path.extname(file);
                // save new filename back to files list
                platform.files[0] = destFile;
            }
            copiedFiles.push(Utils.copyFile(path.resolve(platform.cache, file), path.resolve(platform.releasePath, destFile)));
        });
    });

    return Promise.all(copiedFiles);
};

NwBuilder.prototype.zipAppFiles = function () {
    var self = this;

    // Check if zip is needed
    var _needsZip = false,
        numberOfPlatformsWithoutOverrides = 0;

    self._zips = {};

    this._forEachPlatform(function(name, platform) {
        if(name === 'osx' && self.options.macZip || platform.needsZip) {
            _needsZip = true;
            var platformSpecific = !!platform.platformSpecificManifest;

            self._zips[name] = { platformSpecific: platformSpecific };

            numberOfPlatformsWithoutOverrides += !platformSpecific;
        }
    });

    self._needsZip = _needsZip;

    return new Promise(function(resolve, reject) {

        if(!self._needsZip){
            resolve();
            return;
        }


        // create (or don't create) a ZIP for multiple platforms
        new Promise(function(resolve, reject) {
            if(numberOfPlatformsWithoutOverrides > 1){
                Utils.generateZipFile(self._files, self).then(function (zip) {
                    resolve(zip);
                }, reject);
            }
            else {
                resolve();
            }
        })
        .then(function(platformAgnosticZip){
            var zipPromises = [];

            _.forEach(self._zips, function(zip, platformName){

                if(platformAgnosticZip && !zip.platformSpecific){
                    zip.file = platformAgnosticZip;
                    return;
                }

                zipPromises.push(Utils.generateZipFile(
                    self._files,
                    self,
                    JSON.stringify(self._platforms[platformName].platformSpecificManifest)
                ).then(function(file){
                    zip.file = file;
                }));
            });

            Promise.all(zipPromises).then(resolve, reject);
        }, reject);
    });
};

NwBuilder.prototype.mergeAppFiles = function () {
    var self = this,
        copiedFiles = [];

    this._forEachPlatform(function (name, platform) {
        // We copy the app files if we are on mac and don't force zip
        if(name === 'osx') {
            // no zip, copy the files
            if(!self.options.macZip) {
                self._files.forEach(function (file) {
                    var dest = path.resolve(platform.releasePath, self.options.appName+'.app', 'Contents', 'Resources', 'app.nw', file.dest);

                    if(file.dest === 'package.json' && platform.platformSpecificManifest){
                        copiedFiles.push(self.writePlatformSpecificManifest(platform, dest));
                    }
                    else {
                        copiedFiles.push(Utils.copyFile(file.src, dest));
                    }
                });
            } else {
                // zip just copy the app.nw
                copiedFiles.push(Utils.copyFile(
                    self.getZipFile(name),
                    path.resolve(platform.releasePath, self.options.appName+'.app', 'Contents', 'Resources', 'nw.icns')
                ));
            }
        } else {
            if (!self.options.winExe) {
                // We cat the app.nw file into the .exe / nw
                copiedFiles.push(Utils.mergeFiles(
                    path.resolve(platform.releasePath, _.first(platform.files)),
                    self.getZipFile(name),
                    platform.chmod
                ));
            } else {
                // copy the zip file using nw's preferred package name
                copiedFiles.push(Utils.copyFile(self.getZipFile(name), path.resolve(platform.releasePath, 'package.nw')));
            }
        }
    });

    return Promise.all(copiedFiles);
};

NwBuilder.prototype.getZipFile = function(platformName){
    return this._zips[platformName] && this._zips[platformName].file || null;
};

NwBuilder.prototype.writePlatformSpecificManifest = function(platform, dest){
    return new Promise(function(resolve, reject){
        var pkgParentDirectory = path.join(dest, '../');
        if(!fs.existsSync(pkgParentDirectory)) fs.mkdirpSync(pkgParentDirectory);

        fs.writeFile(dest, JSON.stringify(platform.platformSpecificManifest), function(err){
            if(err) return reject(err);
            resolve();
        });
    })
};

NwBuilder.prototype.handleMacApp = function () {
    var self = this, allDone = [];
    var macPlatform = this._platforms.osx;

    if(!macPlatform) return Promise.resolve();

    // Let's first handle the mac icon
    if(self.options.macIcns) {
        allDone.push(Utils.copyFile(self.options.macIcns, path.resolve(macPlatform.releasePath, self.options.appName+'.app', 'Contents', 'Resources', 'nw.icns')));
    }

    // Handle mac credits
    if(self.options.macCredits) {
        allDone.push(Utils.copyFile(self.options.macCredits, path.resolve(macPlatform.releasePath, self.options.appName+'.app', 'Contents', 'Resources', 'Credits.html')));
    }

    // Let handle the Plist
    var PlistPath = path.resolve(macPlatform.releasePath, self.options.appName+'.app', 'Contents', 'Info.plist');

    // If the macPlist is a string we just copy the file
    if(typeof self.options.macPlist === 'string') {
        allDone.push(Utils.copyFile(self.options.macPlist, PlistPath));
    } else {
        // Setup the Plst
        var defaultPlist = {
            appName: self.options.appName,
            appVersion: self.options.appVersion,
            copyright: self._appPkg.copyright || false
        };

        var plistOptions = (self.options.macPlist ? _.defaults(self.options.macPlist, defaultPlist) : defaultPlist);
        allDone.push(Utils.editPlist(PlistPath, PlistPath, plistOptions));
    }

    return Promise.all(allDone);

};

NwBuilder.prototype.handleWinApp = function () {
    var self = this,
        done = Promise.defer();
    var winPlatform = this._platforms.win;
    if(!winPlatform || !self.options.winIco) return Promise.resolve();

    // Set icon
    if (self.options.winIco) {
        self.emit('log', 'Update executable icon');
        winresourcer({
            operation: "Update",
            exeFile: path.resolve(winPlatform.releasePath, _.first(winPlatform.files)),
            resourceType: "Icongroup",
            resourceName: "IDR_MAINFRAME",
            lang: 1033, // Required, except when updating or deleting
            resourceFile: path.resolve(self.options.winIco)
        }, function(err) {
            if(err) {
                done.reject('Error while updating the Windows icon.' +
                        (process.platform !== "win32" ? ' Wine (winehq.org) must be installed to add custom icons from Mac and Linux.' : '')
                );
            }
            else {
                done.resolve();
            }
        });
    }

    return done.promise;
};

NwBuilder.prototype.runApp = function () {
    var self = this,
        platform = this._platforms[this.options.currentPlatform],
        executable = path.resolve(platform.cache, platform.runable);

    self.emit('log', 'Launching App');
    return new Promise(function(resolve, reject) {
        var p = spawn(executable, ['--enable-logging', self.options.files.replace(/\*[\/\*]*/,"")].concat(self.options.argv));

        p.stdout.on('data', function(data) {
            self.emit('stdout', data);
        });

        p.stderr.on('data', function(data) {
            self.emit('stderr', data);
        });

        p.on('close', function(code) {
            self.emit('log', 'App exited with code ' + code);
            resolve();
        });
    });
};

NwBuilder.prototype._forEachPlatform = function (fn) {
    _.forEach(this._platforms, function(platform, name) {
        return fn(name, platform)
    });
};
