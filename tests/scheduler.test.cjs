'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const tasks = [];
const context = { window: {}, location: { search: '?scheduler=message' }, URLSearchParams,
    performance: { now: () => 123 }, MessageChannel: class {
        constructor() {
            this.port1 = {};
            this.port2 = { postMessage: data => tasks.push(() => this.port1.onmessage({ data })) };
        }
    } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/azahar_scheduler.js'), 'utf8'), context);
const scheduler = context.window.AzaharScheduler;
let calls = 0;
const cancelled = scheduler.request(() => { throw new Error('Cancelled callback executed'); });
scheduler.cancel(cancelled);
scheduler.request(timestamp => {
    assert.equal(timestamp, 123);
    calls++;
    scheduler.request(() => calls++);
});
assert.equal(calls, 0, 'Callbacks must yield rather than execute synchronously');
tasks.shift()();
tasks.shift()();
assert.equal(calls, 1);
scheduler.cancel(cancelled);
tasks.shift()();
assert.equal(calls, 2);
assert.equal(tasks.length, 0);
console.log('Scheduler cancellation and rescheduling tests passed');
