'use strict';

/*
 * Runtime configuration for opening the app as a file or on any static server.
 * The agents run on their rules. server.py answers this path with its own
 * version, which switches on the Claude powered agents when a key is set.
 */
window.BL = window.BL || {};
window.BL.serverConfig = { modelServer: false, enabled: false, model: null, label: 'Claude' };
