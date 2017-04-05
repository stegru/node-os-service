
var child_process = require("child_process");
var fs = require("fs");
var os = require("os");
var util = require ("util");
var events = require("events");

var serviceWrap;
var runInitialised = false;

var linuxStartStopScript = [
	'#!/bin/bash',
	'',
	'### BEGIN INIT INFO',
	'# Provides:          ##NAME##',
	'# Required-Start:    ',
	'# Required-Stop:     ',
	'# Default-Start:     ##RUN_LEVELS_ARR##',
	'# Default-Stop:      0 1 6',
	'# Short-Description: Start ##NAME## at boot time',
	'# Description:       Enable ##NAME## service.',
	'### END INIT INFO',
	'',
	'# chkconfig:   ##RUN_LEVELS_STR## 99 1',
	'# description: ##NAME##',
	'',
	'set_pid () {',
	'	unset PID',
	'	_PID=`head -1 "##PROGRAM_PATH##.pid" 2>/dev/null`',
	'	if [ $_PID ]; then',
	'		kill -0 $_PID 2>/dev/null && PID=$_PID',
	'	fi',
	'}',
	'',
	'force_reload () {',
	'	stop',
	'	start',
	'}',
	'',
	'restart () {',
	'	stop',
	'	start',
	'}',
	'',
	'start () {',
	'	CNT=5',
	'',
	'	set_pid',
	'',
	'	if [ -z "$PID" ]; then',
	'		echo starting ##NAME##',
	'',
	'		"##NODE_PATH##" ##NODE_ARGS## "##PROGRAM_PATH##" ##PROGRAM_ARGS## >/dev/null 2>&1 &',
	'',
	'		echo $! > "##PROGRAM_PATH##.pid"',
	'',
	'		while [ : ]; do',
	'			set_pid',
	'',
	'			if [ -n "$PID" ]; then',
	'				echo started ##NAME##',
	'				break',
	'			else',
	'				if [ $CNT -gt 0 ]; then',
	'					sleep 1',
	'					CNT=`expr $CNT - 1`',
	'				else',
	'					echo ERROR - failed to start ##NAME##',
	'					break',
	'				fi',
	'			fi',
	'		done',
	'	else',
	'		echo ##NAME## is already started',
	'	fi',
	'}',
	'',
	'status () {',
	'	set_pid',
	'',
	'	if [ -z "$PID" ]; then',
	'		exit 1',
	'	else',
	'		exit 0',
	'	fi',
	'}',
	'',
	'stop () {',
	'	CNT=5',
	'',
	'	set_pid',
	'',
	'	if [ -n "$PID" ]; then',
	'		echo stopping ##NAME##',
	'',
	'		kill $PID',
	'',
	'		while [ : ]; do',
	'			set_pid',
	'',
	'			if [ -z "$PID" ]; then',
	'				rm "##PROGRAM_PATH##.pid"',
	'				echo stopped ##NAME##',
	'				break',
	'			else',
	'				if [ $CNT -gt 0 ]; then',
	'					sleep 1',
	'					CNT=`expr $CNT - 1`',
	'				else',
	'					echo ERROR - failed to stop ##NAME##',
	'					break',
	'				fi',
	'			fi',
	'		done',
	'	else',
	'		echo ##NAME## is already stopped',
	'	fi',
	'}',
	'',
	'case $1 in',
	'	force-reload)',
	'		force_reload',
	'		;;',
	'	restart)',
	'		restart',
	'		;;',
	'	start)',
	'		start',
	'		;;',
	'	status)',
	'		status',
	'		;;',
	'	stop)',
	'		stop',
	'		;;',
	'	*)',
	'		echo "usage: $0 <force-reload|restart|start|status|stop>"',
	'		exit 1',
	'		;;',
	'esac'
];

var linuxSystemUnit = [
	'[Unit]',
	'Description=##NAME##',
	'After=network.target',
	'',
	'[Service]',
	'Type=simple',
	'StandardOutput=null',
	'StandardError=null',
	'UMask=0007',
	'ExecStart=##NODE_PATH## ##NODE_ARGS## ##PROGRAM_PATH## ##PROGRAM_ARGS##',
	'',
	'[Install]'
];

function getServiceWrap () {
	if (! serviceWrap)
		serviceWrap = require ("./build/Release/service");
	return serviceWrap;
}

function runProcess(path, args, cb) {
	var child = child_process.spawn(path, args);

	child.on("exit", function(code) {
		if (code != 0) {
			var error = new Error(path + " failed: " + code)
			error.code = code
			cb(error);
		} else {
			cb();
		}
	});

	child.on("error", function(error) {
		if (error) {
			cb(error);
		} else {
			cb();
		}
	});
}

function add (name, options, cb) {
	if (! cb) {
		cb = arguments[1];
		options = {};
	}

	var nodePath = (options && options.nodePath)
			? options.nodePath
			: process.execPath;

	var programPath = (options && options.programPath)
			? options.programPath
			: process.argv[1];

	var username = options ? (options.username || null) : null;
	var password = options ? (options.password || null) : null;

	if (os.platform() == "win32") {
		var displayName = (options && options.displayName)
				? options.displayName
				: name;
		
		var serviceArgs = [];

		serviceArgs.push (nodePath);

		if (options && options.nodeArgs)
			for (var i = 0; i < options.nodeArgs.length; i++)
				serviceArgs.push (options.nodeArgs[i]);

		serviceArgs.push (programPath);
	
		if (options && options.programArgs)
			for (var i = 0; i < options.programArgs.length; i++)
				serviceArgs.push (options.programArgs[i]);
	
		for (var i = 0; i < serviceArgs.length; i++)
			serviceArgs[i] = "\"" + serviceArgs[i] + "\"";
	
		var servicePath = serviceArgs.join (" ");

		try {
			getServiceWrap ().add (name, displayName, servicePath, username,
					password);
			cb();
		} catch (error) {
			cb(error);
		}
	} else {
		var nodeArgs = [];
		if (options && options.nodeArgs)
			for (var i = 0; i < options.nodeArgs.length; i++)
				nodeArgs.push ("\"" + options.nodeArgs[i] + "\"");

		var programArgs = [];
		if (options && options.programArgs)
			for (var i = 0; i < options.programArgs.length; i++)
				programArgs.push ("\"" + options.programArgs[i] + "\"");
		
		var runLevels = [2, 3, 4, 5];
		if (options && options.runLevels)
			runLevels = options.runLevels;

		var nodeArgsStr = nodeArgs.join(" ");
		var programArgsStr = programArgs.join(" ");

		var initPath = "/etc/init.d/" + name;
		var systemPath = "/usr/lib/systemd/system/" + name + ".service";
		var ctlOptions = {
			mode: 493 // rwxr-xr-x
		};

		fs.stat("/usr/lib/systemd/system", function(error, stats) {
			if (error) {
				if (error.code == "ENOENT") {
					var startStopScript = [];

					for (var i = 0; i < linuxStartStopScript.length; i++) {
						var line = linuxStartStopScript[i];
						
						line = line.replace("##NAME##", name);
						line = line.replace("##NODE_PATH##", nodePath);
						line = line.replace("##NODE_ARGS##", nodeArgsStr);
						line = line.replace("##PROGRAM_PATH##", programPath);
						line = line.replace("##PROGRAM_ARGS##", programArgsStr);
						line = line.replace("##RUN_LEVELS_ARR##", runLevels.join(" "));
						line = line.replace("##RUN_LEVELS_STR##", runLevels.join(""));
						
						startStopScript.push(line);
					}
					
					var startStopScriptStr = startStopScript.join("\n");

					fs.writeFile(initPath, startStopScriptStr, ctlOptions, function(error) {
						if (error) {
							cb(new Error("writeFile(" + initPath + ") failed: " + error.message));
						} else {
							runProcess("chkconfig", ["--add", name], function(error) {
								if (error) {
									if (error.code == "ENOENT") {
										runProcess("update-rc.d", [name, "defaults"], function(error) {
											if (error) {
												cb(new Error("update-rd.d failed: " + error.message));
											} else {
												cb()
											}
										})
									} else {
										cb(new Error("chkconfig failed: " + error.message));
									}
								} else {
									cb()
								}
							})
						}
					})
				} else {
					cb(new Error("stat(/usr/lib/systemd/system) failed: " + error.message));
				}
			} else {
				var systemUnit = [];

				for (var i = 0; i < linuxSystemUnit.length; i++) {
					var line = linuxSystemUnit[i];
					
					line = line.replace("##NAME##", name);
					line = line.replace("##NODE_PATH##", nodePath);
					line = line.replace("##NODE_ARGS##", nodeArgsStr);
					line = line.replace("##PROGRAM_PATH##", programPath);
					line = line.replace("##PROGRAM_ARGS##", programArgsStr);
					
					systemUnit.push(line);
				}
				
				var systemUnitStr = systemUnit.join("\n");

				fs.writeFile(systemPath, systemUnitStr, ctlOptions, function(error) {
					if (error) {
						cb(new Error("writeFile(" + systemPath + ") failed: " + error.message));
					} else {
						runProcess("systemctl", ["enable", name], function(error) {
							if (error) {
								cb(new Error("systemctl failed: " + error.message));
							} else {
								cb()
							}
						})
					}
				})
			}
		})
	}
	
	return this;
}

function isStopRequested () {
	return getServiceWrap ().isStopRequested ();
}

function remove (name, cb) {
	if (os.platform() == "win32") {
		try {
			getServiceWrap ().remove (name);
			cb();
		} catch (error) {
			cb(error);
		}
	} else {
		var initPath = "/etc/init.d/" + name;
		var systemPath = "/usr/lib/systemd/system/" + name + ".service";

		function removeCtlPaths() {
			fs.unlink(initPath, function(error) {
				if (error) {
					if (error.code == "ENOENT") {
						fs.unlink(systemPath, function(error) {
							if (error) {
								cb(new Error("unlink(" + systemPath + ") failed: " + error.message))
							} else {
								cb()
							}
						});
					} else {
						cb(new Error("unlink(" + initPath + ") failed: " + error.message))
					}
				} else {
					cb()
				}
			});
		};

		fs.stat("/usr/lib/systemd/system", function(error, stats) {
			if (error) {
				if (error.code == "ENOENT") {
					runProcess("chkconfig", ["--del", name], function(error) {
						if (error) {
							if (error.code == "ENOENT") {
								runProcess("update-rc.d", [name, "remove"], function(error) {
									if (error) {
										cb(new Error("update-rc.d failed: " + error.message));
									} else {
										removeCtlPaths()
									}
								});
							} else {
								cb(new Error("chkconfig failed: " + error.message));
							}
						} else {
							removeCtlPaths()
						}
					})
				} else {
					cb(new Error("stat(/usr/lib/systemd/system) failed: " + error.message));
				}
			} else {
				runProcess("systemctl", ["disable", name], function(error) {
					if (error) {
						cb(new Error("systemctl failed: " + error.message));
					} else {
						removeCtlPaths()
					}
				})
			}
		})
	}
}

function run (stdoutLogStream, stderrLogStream, stopCallback) {
	if (! stopCallback) {
		stopCallback = stderrLogStream;
		stderrLogStream = stdoutLogStream;
	}

	if (! runInitialised) {
		process.__defineGetter__('stdout', function() {
			return stdoutLogStream;
		});
		
		process.__defineGetter__('stderr', function() {
			return stderrLogStream;
		});
		
		if (os.platform() != "win32") {
			process.on("SIGINT", function() {
				stopCallback ();
			});

			process.on("SIGTERM", function() {
				stopCallback ();
			});
		}
		
		runInitialised = true;
	}
	
	if (os.platform() == "win32") {
	    startWindowsService(stopCallback);
	}
}

function stop (rcode) {
	if (os.platform() == "win32") {
		getServiceWrap ().stop (rcode);
	}
	process.exit (rcode || 0);
}

function startWindowsService(stopCallback) {

    getServiceWrap ().run (serviceCallback);

    acceptControl ("stop");

    // Called in response to the HandlerEx callback in the service.
    // https://msdn.microsoft.com/library/ms683241
    function serviceCallback (control, eventType) {
        var name = controlNames[control];

        var eventTypeName = eventTypes[name] && eventTypes[name][eventType];

        eventEmitter.emit (name, name, eventTypeName);
        eventEmitter.emit ("*", name, eventTypeName);

        switch (name) {
        case "stop":
            if (stopCallback) {
                setTimeout(stopCallback, 1000);
            }
            break;
        case "pause":
            setState("paused");
            break;
        case "continue":
            setState("running");
            break;
        }
    }
}

function setState(stateName) {
    if (os.platform() !== "win32") {
        return;
    }

    if (stateName === "stopped") {
        stop(0);
    } else {
        var state = states[stateName];
        getServiceWrap().setState(state);
    }
}

function getState() {
    if (os.platform() !== "win32") {
        return;
    }

    var state = getServiceWrap().getState();
    return stateNames[state] || "stopped";
}

function acceptControl(controlName, add) {
    add = add !== false;

    var serviceAcceptFlags = {
        // SERVICE_ACCEPT_STOP
        "stop": 0x00000001,
        // SERVICE_ACCEPT_PAUSE_CONTINUE
        "pause": 0x00000002,
        "continue": 0x00000002,
        // SERVICE_ACCEPT_SHUTDOWN
        "shutdown": 0x00000004,
        // SERVICE_ACCEPT_PARAMCHANGE
        "paramchange": 0x00000008,
        // SERVICE_ACCEPT_NETBINDCHANGE
        "netbindadd": 0x00000010,
        "netbindremove": 0x00000010,
        "netbindenable": 0x00000010,
        "netbinddisable": 0x00000010,
        // SERVICE_ACCEPT_HARDWAREPROFILECHANGE
        "hardwareprofilechange": 0x00000020,
        // SERVICE_ACCEPT_POWEREVENT
        "powerevent": 0x00000040,
        // SERVICE_ACCEPT_SESSIONCHANGE
        "sessionchange": 0x00000080,
        // SERVICE_ACCEPT_PRESHUTDOWN
        "preshutdown": 0x00000100,
        // SERVICE_ACCEPT_TIMECHANGE
        "timechange": 0x00000200,
        // SERVICE_ACCEPT_TRIGGEREVENT
        "triggerevent": 0x00000400
    };

    var all = Array.isArray(controlName) ? controlName : [ controlName ];

    for (var n = 0; n < all.length; n++) {
        var control = all[n];
        var flag = serviceAcceptFlags.hasOwnProperty(control) && serviceAcceptFlags[control];

        if (add) {
            controlsAccepted |= flag;
        } else {
            controlsAccepted &= ~flag;
        }
    }

    if (runInitialised) {
        getServiceWrap().setControlsAccepted(controlsAccepted);
    }
}

var controlsAccepted = 0;
var controlCodes = {
    "start":                 0,      // not a real control code
    "stop":                  0x0001, // SERVICE_CONTROL_STOP
    "pause":                 0x0002, // SERVICE_CONTROL_PAUSE
    "continue":              0x0003, // SERVICE_CONTROL_CONTINUE
    "interrogate":           0x0004, // SERVICE_CONTROL_INTERROGATE
    "shutdown":              0x0005, // SERVICE_CONTROL_SHUTDOWN
    "paramchange":           0x0006, // SERVICE_CONTROL_PARAMCHANGE
    "netbindadd":            0x0007, // SERVICE_CONTROL_NETBINDADD
    "netbindremove":         0x0008, // SERVICE_CONTROL_NETBINDREMOVE
    "netbindenable":         0x0009, // SERVICE_CONTROL_NETBINDENABLE
    "netbinddisable":        0x000A, // SERVICE_CONTROL_NETBINDDISABLE
    "deviceevent":           0x000B, // SERVICE_CONTROL_DEVICEEVENT
    "hardwareprofilechange": 0x000C, // SERVICE_CONTROL_HARDWAREPROFILECHANGE
    "powerevent":            0x000D, // SERVICE_CONTROL_POWEREVENT
    "sessionchange":         0x000E, // SERVICE_CONTROL_SESSIONCHANGE
    "preshutdown":           0x000F, // SERVICE_CONTROL_PRESHUTDOWN
    "timechange":            0x0010, // SERVICE_CONTROL_TIMECHANGE
    "triggerevent":          0x0020  // SERVICE_CONTROL_TRIGGEREVENT
};
var controlNames = flip(controlCodes);

var states = {
    "stopped":          0x01, // SERVICE_STOPPED
    "start-pending":    0x02, // SERVICE_START_PENDING
    "stop-pending":     0x03, // SERVICE_STOP_PENDING
    "running":          0x04, // SERVICE_RUNNING
    "continue-pending": 0x05, // SERVICE_CONTINUE_PENDING
    "pause-pending":    0x06, // SERVICE_PAUSE_PENDING
    "paused":           0x07  // SERVICE_PAUSED
};
var stateNames = flip(states);

var eventTypes = {
    "sessionchange": {
        0x01: "console-connect",         // WTS_CONSOLE_CONNECT
        0x02: "console-disconnect",      // WTS_CONSOLE_DISCONNECT
        0x03: "remote-connect",          // WTS_REMOTE_CONNECT
        0x04: "remote-disconnect",       // WTS_REMOTE_DISCONNECT
        0x05: "session-logon",           // WTS_SESSION_LOGON
        0x06: "session-logoff",          // WTS_SESSION_LOGOFF
        0x07: "session-lock",            // WTS_SESSION_LOCK
        0x08: "session-unlock",          // WTS_SESSION_UNLOCK
        0x09: "session-remote-control",  // WTS_SESSION_REMOTE_CONTROL
        0x0A: "session-create",          // WTS_SESSION_CREATE
        0x0B: "session-terminate"        // WTS_SESSION_TERMINATE
    }
};

function flip(obj) {
    var togo = {};
    for (var prop in obj) {
        if (obj.hasOwnProperty(prop)) {
            togo[obj[prop]] = prop;
        }
    }
    return togo;
}

var eventEmitter = new events.EventEmitter();

/**
 * Adds an event listener for a service code.
 *
 * @param eventName start|stop|pause|continue|interrogate|shutdown|paramchange|netbindadd|netbindremove|netbindenable|
 * netbinddisable|deviceevent|hardwareprofilechange|powerevent|sessionchange|preshutdown|timechange|triggerevent
 * @param fn
 */
function on(eventName, fn) {
    if (os.platform() == "win32") {
        acceptControl (eventName);
        eventEmitter.on (eventName, fn);
    }
}
exports.add = add;
exports.remove = remove;
exports.run = run;
exports.stop = stop;
exports.on = on;
exports.setState = setState;
exports.getState = getState;
exports.acceptControl = acceptControl;
