/**
 * game_library.test.cjs
 * Comprehensive verification of the Shared 3DS Game Library
 */
'use strict';

const puppeteer = require('puppeteer-core');
const { listen } = require('../web/server.cjs');
const cfg = require('./config.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

async function runTests() {
    console.log('--- Starting Game Library Tests ---');
    const port = 8788;
    const server = await listen(port, '127.0.0.1');
    console.log(`Server listening on http://127.0.0.1:${port}`);

    const browser = await puppeteer.launch({
        executablePath: cfg.chromePath,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--use-gl=swiftshader'
        ]
    });

    try {
        const page = await browser.newPage();
        page.on('console', msg => { if (msg.type() === 'error') console.error('Browser console error:', msg.text()); });
        await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
        console.log('Page loaded successfully.');

        // 1. Wait for library catalog to load
        console.log('Test 1: Waiting for catalog load...');
        await page.waitForFunction(() => {
            const badge = document.getElementById('library-count-badge');
            return badge && badge.textContent.includes('1,945 games available');
        }, { timeout: 10000 });

        const badgeText = await page.$eval('#library-count-badge', el => el.textContent);
        console.log(`  ✓ Badge text: "${badgeText}"`);
        assert.ok(badgeText.includes('1,945'), 'Badge must indicate 1,945 games');

        // 2. Check initial table rows
        console.log('Test 2: Checking default page table rows...');
        const initialRows = await page.$$eval('#library-list tr', rows => rows.length);
        console.log(`  ✓ Default page rows: ${initialRows}`);
        assert.strictEqual(initialRows, 50, 'Default page size should be 50');

        // 3. Test Search for "Pascal"
        console.log('Test 3: Searching for "Pascal"...');
        await page.click('#library-search');
        await page.type('#library-search', 'Pascal');
        await page.waitForFunction(() => {
            const rows = document.querySelectorAll('#library-list tr');
            return rows.length === 1;
        }, { timeout: 10000 });

        const searchResults = await page.$$eval('#library-list tr', rows => {
            return rows.map(r => ({
                title: r.querySelector('.game-name')?.textContent,
                filename: r.querySelector('.game-filename')?.textContent,
                region: r.querySelector('.region-badge')?.textContent,
                downloadHref: r.querySelector('a[download]')?.href,
                archiveHref: r.querySelectorAll('a')[1]?.href
            }));
        });
        console.log('  ✓ Search results found:', searchResults.length);
        assert.ok(searchResults.length >= 1, 'Should find at least 1 Pascal Sensei entry');
        const pascal = searchResults[0];
        console.log('  ✓ Pascal Sensei game title:', pascal.title);
        console.log('  ✓ Pascal Sensei filename:', pascal.filename);
        console.log('  ✓ Pascal Sensei direct download URL:', pascal.downloadHref);
        console.log('  ✓ Pascal Sensei archive view URL:', pascal.archiveHref);

        assert.ok(pascal.title.includes('Pascal Sensei'), 'Title must contain Pascal Sensei');
        assert.ok(pascal.filename.includes('Decrypted.3ds'), 'Filename must be Decrypted.3ds');
        assert.ok(pascal.downloadHref.includes('Pascal%20Sensei') && pascal.downloadHref.includes('.3ds'), 'Download URL must point to .3ds');
        assert.ok(pascal.archiveHref.includes('view_archive.php') && pascal.archiveHref.includes('Pascal'), 'Archive URL must be view_archive.php');

        // 4. Test Search Clear
        console.log('Test 4: Clearing search...');
        await page.click('#library-search-clear');
        await page.waitForFunction(() => {
            const rows = document.querySelectorAll('#library-list tr');
            return rows.length === 50;
        }, { timeout: 5000 });
        console.log('  ✓ Search cleared, back to 50 rows.');

        // 5. Test Region Filtering
        console.log('Test 5: Testing Region filter (USA)...');
        await page.click('.filter-pill[data-region="USA"]');
        await page.waitForFunction(() => {
            const pageInfo = document.getElementById('library-page-info');
            return pageInfo && pageInfo.textContent.includes('games') && !pageInfo.textContent.includes('1,945');
        }, { timeout: 5000 });

        const usaPageInfo = await page.$eval('#library-page-info', el => el.textContent);
        console.log(`  ✓ USA Filter Page Info: "${usaPageInfo}"`);
        assert.ok(usaPageInfo.includes('474 games'), 'Should show 474 USA games');

        // Verify USA rows only contain USA
        const usaRegions = await page.$$eval('#library-list .region-badge', badges => badges.map(b => b.textContent));
        assert.ok(usaRegions.every(r => r.includes('USA')), 'All rows under USA filter must be USA');

        // Test Region Filter (Japan)
        console.log('Test 5b: Testing Region filter (Japan)...');
        await page.click('.filter-pill[data-region="Japan"]');
        await page.waitForFunction(() => {
            const pageInfo = document.getElementById('library-page-info');
            return pageInfo && pageInfo.textContent.includes('728 games');
        }, { timeout: 5000 });
        const japanPageInfo = await page.$eval('#library-page-info', el => el.textContent);
        console.log(`  ✓ Japan Filter Page Info: "${japanPageInfo}"`);
        assert.ok(japanPageInfo.includes('728 games'), 'Should show 728 Japan games');

        // Search and region filters must compose, and clearing search must
        // preserve the currently selected region.
        await page.$eval('#library-search', el => {
            el.value = 'Pascal';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() => document.querySelectorAll('#library-list tr').length === 1);
        assert.ok((await page.$eval('#library-list .region-badge', el => el.textContent)).includes('Japan'),
            'Search results must still obey the selected Japan region filter');
        await page.$eval('#library-search', el => {
            el.value = 'no game should match this string';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() => !document.getElementById('library-empty').hidden);
        assert.strictEqual(await page.$$eval('#library-list tr', rows => rows.length), 0,
            'Unmatched search must clear stale rows');
        await page.click('#library-search-clear');
        await page.waitForFunction(() => document.querySelectorAll('#library-list tr').length === 50);
        assert.ok((await page.$eval('#library-page-info', el => el.textContent)).includes('728 games'),
            'Clearing search should retain the Japan filter');

        // Restore to All
        await page.click('.filter-pill[data-region="all"]');
        await page.waitForFunction(() => {
            const pageInfo = document.getElementById('library-page-info');
            return pageInfo && pageInfo.textContent.includes('1,945 games');
        }, { timeout: 5000 });
        console.log('  ✓ Restored All filter.');

        // 6. Test Pagination
        console.log('Test 6: Testing Pagination (Next / Prev)...');
        const firstGamePage1 = await page.$eval('#library-list .game-name', el => el.textContent);
        await page.click('#library-next-page');
        await page.waitForFunction((prev) => {
            const first = document.querySelector('#library-list .game-name');
            return first && first.textContent !== prev;
        }, { timeout: 5000 }, firstGamePage1);

        const firstGamePage2 = await page.$eval('#library-list .game-name', el => el.textContent);
        console.log(`  ✓ Page 1 First: "${firstGamePage1}", Page 2 First: "${firstGamePage2}"`);
        assert.notStrictEqual(firstGamePage1, firstGamePage2, 'Page 2 should show different games');

        await page.click('#library-prev-page');
        await page.waitForFunction((first) => {
            const current = document.querySelector('#library-list .game-name');
            return current && current.textContent === first;
        }, { timeout: 5000 }, firstGamePage1);
        console.log('  ✓ Returned to Page 1 successfully.');

        // 7. Test Browse Library quick button
        console.log('Test 7: Testing "Browse Shared Library" quick jump button...');
        await page.click('#btn-browse-library');
        const isSearchFocused = await page.evaluate(() => {
            return document.activeElement === document.getElementById('library-search');
        });
        console.log('  ✓ Library search input focused after quick-jump click:', isSearchFocused);
        assert.ok(isSearchFocused, 'Search input should be focused on quick jump click');

        // 8. Test AzaharUI integration API
        console.log('Test 8: Verifying AzaharUI global API and streaming setup...');
        const hasApi = await page.evaluate(() => {
            return {
                hasAzaharUI: typeof window.AzaharUI !== 'undefined',
                hasLoadRomBytes: typeof window.AzaharUI?.loadRomBytes === 'function',
                hasAzaharLibrary: typeof window.AzaharLibrary !== 'undefined',
                hasStreamRom: typeof window.AzaharLibrary?.streamRom === 'function',
                totalGamesInLib: window.AzaharLibrary?.getAllGames().length
            };
        });
        console.log('  ✓ API check:', hasApi);
        assert.ok(hasApi.hasAzaharUI, 'AzaharUI must exist on window');
        assert.ok(hasApi.hasLoadRomBytes, 'AzaharUI.loadRomBytes must be a function');
        assert.ok(hasApi.hasAzaharLibrary, 'AzaharLibrary must exist on window');
        assert.strictEqual(hasApi.totalGamesInLib, 1945, 'AzaharLibrary should hold all 1,945 games');
        // Switching to an Internet Archive metadata database loads its files
        // into the same searchable table. Use a local response fixture so the
        // test does not depend on Archive availability.
        const rarFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-eshop-title.rar'));
        await page.evaluate(rarBytes => {
            const originalFetch = window.fetch.bind(window);
            window.__archiveDownloadCount = 0;
            const files = [
                { name: '0023 - Picross e (Japan) (eShop).rar', size: '123456', format: 'RAR' },
                { name: 'Homebrew Demo (USA).cia', size: '654321', format: 'Nintendo 3DS Content' },
                { name: 'item_meta.xml', size: '20', format: 'Metadata' }
            ];
            window.fetch = (input, options) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url === 'https://archive.org/metadata/3ds-cia-eshop') {
                    return Promise.resolve(new Response(JSON.stringify({ files }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }
                if (url === 'https://archive.org/download/3ds-cia-eshop/0023%20-%20Picross%20e%20(Japan)%20(eShop).rar') {
                    window.__archiveDownloadCount++;
                    return Promise.resolve(new Response(new Uint8Array(rarBytes), {
                        status: 200,
                        headers: { 'Content-Type': 'application/vnd.rar' }
                    }));
                }
                return originalFetch(input, options);
            };
        }, [...rarFixture]);
        await page.select('#library-source', 'eshop');
        await page.waitForFunction(() => document.getElementById('library-count-badge')?.textContent === '2 files available');
        await page.$eval('#library-search', el => {
            el.value = 'Picross';
            el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() => document.querySelectorAll('#library-list tr').length === 1);
        assert.ok((await page.$eval('#library-list .game-name', el => el.textContent)).includes('Picross e'),
            'Search should work against the selected Archive database');
        await page.click('#library-search-clear');
        await page.waitForFunction(() => document.querySelectorAll('#library-list tr').length === 2);
        assert.strictEqual(await page.$$eval('#library-list tr', rows => rows.length), 2,
            'The selected archive database should populate the library');
        const archiveRows = await page.$$eval('#library-list tr', rows => rows.map(row => ({
            title: row.querySelector('.game-name')?.textContent,
            href: row.querySelector('a[download]')?.href,
            canPlay: Boolean(row.querySelector('.play-btn')),
            playText: row.querySelector('.play-btn')?.textContent
        })));
        const rarEntry = archiveRows.find(row => row.href.endsWith('.rar'));
        const ciaEntry = archiveRows.find(row => row.href.endsWith('.cia'));
        assert.ok(rarEntry?.title.includes('Picross e'), 'Archive metadata filename should become a searchable title');
        assert.ok(rarEntry.canPlay, 'RAR archives containing CIA files should show a play action');
        assert.ok(rarEntry.playText.includes('Extract & Play'), 'RAR play action should explain it extracts the game first');
        assert.ok(ciaEntry?.canPlay, 'Direct CIA files should retain the play action');

        // A RAR play action downloads the archive, extracts its CIA in the
        // browser worker, and passes the extracted file to the emulator loader.
        await page.evaluate(() => {
            window.__loadedArchiveRom = null;
            window.AzaharUI.loadRomBytes = async (bytes, name, shouldAutoStart) => {
                window.__loadedArchiveRom = { name, length: bytes.length, shouldAutoStart };
            };
        });
        await page.evaluate(() => {
            const row = [...document.querySelectorAll('#library-list tr')]
                .find(candidate => candidate.querySelector('a[download]')?.href.endsWith('.rar'));
            row.querySelector('.play-btn').click();
        });
        await page.waitForFunction(() => window.__loadedArchiveRom !== null, { timeout: 15000 }).catch(async error => {
            console.error('RAR play did not finish:', await page.evaluate(() => ({
                status: document.getElementById('active-download-speed')?.textContent,
                loaded: window.__loadedArchiveRom
            })));
            throw error;
        });
        const loadedArchiveRom = await page.evaluate(() => window.__loadedArchiveRom);
        assert.strictEqual(loadedArchiveRom.name, 'Sample eShop title.cia', 'RAR play must pass the extracted CIA filename to Azahar');
        assert.strictEqual(loadedArchiveRom.length, 7, 'RAR play must pass extracted CIA bytes to Azahar');
        assert.strictEqual(loadedArchiveRom.shouldAutoStart, true, 'RAR play should auto-start the extracted title');

        await page.evaluate(() => { window.__loadedArchiveRom = null; });
        await page.evaluate(() => {
            const row = [...document.querySelectorAll('#library-list tr')]
                .find(candidate => candidate.querySelector('a[download]')?.href.endsWith('.rar'));
            row.querySelector('.play-btn').click();
        });
        await page.waitForFunction(() => window.__loadedArchiveRom !== null, { timeout: 15000 });
        assert.strictEqual(await page.evaluate(() => window.__archiveDownloadCount), 1,
            'Playing the same eShop title again must reuse its cached archive instead of downloading it again');

        const sourceHref = await page.$eval('#library-source-link', link => link.href);
        assert.strictEqual(sourceHref, 'https://archive.org/download/3ds-cia-eshop/');

        console.log('\n--- ALL GAME LIBRARY TESTS PASSED! ---');
    } finally {
        await browser.close();
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
