#!/usr/bin/env node
'use strict';

const { createServer, main } = require('./server');

module.exports = { createServer };

if (require.main === module) main();

