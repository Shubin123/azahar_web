/**
 * Azahar WebAssembly E2E Test Runner (tests/e2e/run_e2e_tests.js)
 * Executes 138 test cases across Tiers 1-4, reports TAP version 13 console output,
 * and outputs JSON test results to tests/e2e/test_results.json.
 */

const fs = require('fs');
const path = require('path');
const { E2EHarness } = require('./harness');

const RESULTS_FILE = path.join(__dirname, 'test_results.json');

class TestRunner {
    constructor() {
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
        this.results = [];
        this.harness = new E2EHarness();
    }

    registerTest(id, tier, feature, description, fn) {
        this.tests.push({ id, tier, feature, description, fn });
    }

    async run() {
        console.log(`TAP version 13`);
        console.log(`1..${this.tests.length}`);

        const startTime = Date.now();

        for (let i = 0; i < this.tests.length; i++) {
            const test = this.tests[i];
            const testNum = i + 1;
            this.harness.reset();
            let pass = false;
            let errorMsg = null;

            try {
                await test.fn(this.harness);
                pass = true;
                this.passed++;
                console.log(`ok ${testNum} - [${test.tier}] ${test.id}: ${test.description}`);
            } catch (err) {
                this.failed++;
                errorMsg = err ? (err.message || String(err)) : 'Unknown error';
                console.log(`not ok ${testNum} - [${test.tier}] ${test.id}: ${test.description}`);
                console.log(`  ---`);
                console.log(`  error: "${errorMsg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
                console.log(`  ...`);
            }

            this.results.push({
                num: testNum,
                id: test.id,
                tier: test.tier,
                feature: test.feature,
                description: test.description,
                passed: pass,
                error: errorMsg
            });
        }

        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n# Test Summary: Total=${this.tests.length}, Passed=${this.passed}, Failed=${this.failed}, Time=${durationSec}s`);

        const reportData = {
            timestamp: new Date().toISOString(),
            totalTests: this.tests.length,
            passed: this.passed,
            failed: this.failed,
            durationSeconds: parseFloat(durationSec),
            passRatePercentage: this.tests.length > 0 ? parseFloat(((this.passed / this.tests.length) * 100).toFixed(2)) : 0.0,
            results: this.results
        };

        fs.writeFileSync(RESULTS_FILE, JSON.stringify(reportData, null, 2), 'utf-8');
        console.log(`# Test results written to ${RESULTS_FILE}`);

        process.exit(this.failed === 0 ? 0 : 1);
    }
}

// Instantiate runner
const runner = new TestRunner();

// Helper test registration function passed to tier modules
function addTest(id, tier, feature, description, fn) {
    runner.registerTest(id, tier, feature, description, fn);
}

module.exports = { runner, addTest, TestRunner };

// Load test specifications
const tierModules = [
    './tier1_features',
    './tier2_boundaries',
    './tier3_pairwise',
    './tier4_workloads'
];

for (const modPath of tierModules) {
    try {
        const mod = require(modPath);
        if (typeof mod === 'function') {
            mod(addTest);
        }
    } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') {
            console.error(`Error loading test module ${modPath}:`, err);
        }
    }
}

if (require.main === module) {
    runner.run();
}
