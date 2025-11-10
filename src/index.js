import { chromium } from 'playwright';
import fs from "fs";
import shell from "shelljs";

// Helper function to create debug loggers
const createDebugLoggers = (DEBUG) => {
  const debugLog = (...args) => {
    if (DEBUG) console.log('[DEBUG]', ...args);
  };
  const debugError = (...args) => {
    if (DEBUG) console.error('[DEBUG ERROR]', ...args);
  };
  return { debugLog, debugError };
};

// Helper function to calculate Eastern timezone offset (EDT/EST) based on date
const getEasternOffset = (dateString) => {
  // Parse the date
  const date = new Date(dateString + 'T12:00:00Z'); // Parse as UTC to avoid local timezone issues
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-11
  const day = date.getUTCDate();

  // DST in US Eastern Time:
  // Starts: 2nd Sunday in March (2:00 AM EST -> 3:00 AM EDT)
  // Ends: 1st Sunday in November (2:00 AM EDT -> 1:00 AM EST)

  // Find 2nd Sunday in March
  const march1 = new Date(Date.UTC(year, 2, 1)); // March 1
  const march1Day = march1.getUTCDay(); // 0=Sunday, 1=Monday, etc.
  const daysToSecondSunday = march1Day === 0 ? 7 : (7 - march1Day) + 7; // Days to 2nd Sunday
  const dstStart = new Date(Date.UTC(year, 2, daysToSecondSunday)); // 2nd Sunday in March

  // Find 1st Sunday in November
  const nov1 = new Date(Date.UTC(year, 10, 1)); // November 1
  const nov1Day = nov1.getUTCDay();
  const daysToFirstSunday = nov1Day === 0 ? 0 : (7 - nov1Day); // Days to 1st Sunday
  const dstEnd = new Date(Date.UTC(year, 10, daysToFirstSunday)); // 1st Sunday in November

  // Check if date is during DST period
  const currentDate = new Date(Date.UTC(year, month, day));
  if (currentDate >= dstStart && currentDate < dstEnd) {
    return '-0400'; // EDT (Eastern Daylight Time)
  } else {
    return '-0500'; // EST (Eastern Standard Time)
  }
};

// Gathers needed git commands for bash to execute per provided contribution data.
const getCommand = (contribution, personalName, personalEmail) => {
  // Escape quotes in name and email for shell safety
  const escapedName = personalName.replace(/"/g, '\\"');
  const escapedEmail = personalEmail.replace(/"/g, '\\"');
  
  // Get Eastern timezone offset (handles DST)
  const easternOffset = getEasternOffset(contribution.date);
  
  // Generate individual commits with unique timestamps (incrementing seconds)
  // Each commit modifies contributions.txt file for real file changes
  // Includes idempotency checks to prevent duplicate commits if script is run multiple times
  let commands = '';
  for (let i = 0; i < contribution.count; i++) {
    // Start at 12:00:00 and increment by 1 second for each commit
    const seconds = String(i).padStart(2, '0');
    const minutes = String(Math.floor(i / 60)).padStart(2, '0');
    const hours = 12 + Math.floor(i / 3600);
    const time = `${String(hours).padStart(2, '0')}:${minutes}:${seconds}`;
    
    const entryLine = `${contribution.date} ${time} - Contribution #${i + 1}`;
    
    // Add idempotency check: only append if this exact line doesn't already exist
    // This prevents duplicate commits if the script is accidentally run multiple times
    commands += `if ! grep -Fxq "${entryLine}" contributions.txt 2>/dev/null; then\n`;
    commands += `  echo "${entryLine}" >> contributions.txt\n`;
    commands += `  git add contributions.txt\n`;
    commands += `  GIT_AUTHOR_NAME="${escapedName}" GIT_AUTHOR_EMAIL="${escapedEmail}" GIT_COMMITTER_NAME="${escapedName}" GIT_COMMITTER_EMAIL="${escapedEmail}" GIT_AUTHOR_DATE="${contribution.date}T${time}${easternOffset}" GIT_COMMITTER_DATE="${contribution.date}T${time}${easternOffset}" git commit -m "Contribution for ${contribution.date}" > /dev/null\n`;
    commands += `fi\n`;
  }
  
  return commands;
};

// Read existing contributions from contributions.txt to enable incremental imports
const getExistingContributions = () => {
  try {
    // Check if contributions.txt exists in the repository
    if (!fs.existsSync('contributions.txt')) {
      return {}; // No existing contributions - this is a fresh import
    }
    
    const content = fs.readFileSync('contributions.txt', 'utf-8');
    const existing = {};
    
    // Parse each line: "2022-02-21 12:00:00 - Contribution #1"
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) {
        const date = match[1];
        existing[date] = (existing[date] || 0) + 1;
      }
    }
    
    return existing;
  } catch (err) {
    console.warn('⚠️  Could not read existing contributions:', err.message);
    return {};
  }
};

export default async (input) => {
  // Check for debug flag from command line arguments or input parameter
  const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === 'true' || input.debug === true;
  const { debugLog, debugError } = createDebugLoggers(DEBUG);

  // Save original environment variables and error handlers
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const originalNodePath = process.env.NODE_PATH;
  const originalYarnPnpUnplugged = process.env.YARN_PNP_UNPLUGGED_FOLDER;
  const originalYarnPnpEnable = process.env.YARN_PNP_ENABLE;

  // Unset Yarn PnP environment variables before launching Playwright
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  delete process.env.YARN_PNP_UNPLUGGED_FOLDER;
  delete process.env.YARN_PNP_ENABLE;

  // Set up error handlers to suppress Yarn PnP cleanup errors
  const suppressYarnPnpErrors = (err) => {
    if (err && (
      err.code === 'ERR_INVALID_ARG_TYPE' ||
      (err.stack && err.stack.includes('.pnp.cjs'))
    )) {
      // Silently ignore Yarn PnP cleanup errors
      return;
    }
    // For other errors, log them
    debugError('Uncaught error:', err);
  };

  process.on('uncaughtException', suppressYarnPnpErrors);
  process.on('unhandledRejection', suppressYarnPnpErrors);

  let browser;
  try {
    debugLog('Launching browser...');
    browser = await chromium.launch({
      headless: true,
    });

    const page = await browser.newPage();
    
    debugLog(`Navigating to GitHub profile: ${input.username}`);
    await page.goto(`https://github.com/${input.username}?tab=overview&from=${input.year}-01-01&to=${input.year}-12-31`, {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    debugLog('Waiting for contribution calendar to load...');
    
    // Wait for the calendar container to appear first
    try {
      await page.waitForSelector('.js-calendar-graph, .ContributionCalendar', { timeout: 60000 });
      debugLog('Calendar container found');
    } catch (err) {
      debugLog('Calendar container not found, continuing anyway...');
    }

    // Wait a bit for JavaScript to render
    await page.waitForTimeout(3000);

    // Wait for contribution cells to appear
    try {
      await page.waitForFunction(() => {
        const cells = document.querySelectorAll('td.ContributionCalendar-day, td[data-date], .ContributionCalendar td');
        return cells.length > 50; // Should have many cells for a full year
      }, { timeout: 30000 });
      debugLog('Contribution cells found');
    } catch (err) {
      debugLog('Timeout waiting for cells, but continuing to try extraction...');
    }

    debugLog('Extracting contribution data...');
    
    const contributionData = await page.evaluate(() => {
      const result = {
        contributions: [],
        totalFromPage: 0
      };

      // Try to extract total from the page heading
      const heading = document.querySelector('h2.f4.text-normal.mb-2');
      if (heading) {
        const text = heading.textContent;
        const match = text.match(/([0-9,]+)\s+contribution/);
        if (match) {
          result.totalFromPage = parseInt(match[1].replace(/,/g, ''));
        }
      }

      // Try multiple selectors to find contribution cells
      let elements = document.querySelectorAll('td.ContributionCalendar-day');
      if (elements.length === 0) {
        elements = document.querySelectorAll('td[data-date]');
      }
      if (elements.length === 0) {
        const table = document.querySelector('table.ContributionCalendar-grid');
        if (table) {
          elements = table.querySelectorAll('td');
        }
      }
      if (elements.length === 0) {
        const container = document.querySelector('.ContributionCalendar');
        if (container) {
          elements = container.querySelectorAll('td');
        }
      }

      let foundWithTooltip = 0;
      let foundWithAriaLabel = 0;
      let foundWithDataCount = 0;
      let foundWithDataLevel = 0;
      let skippedNoContributions = 0;

      elements.forEach((el) => {
        const date = el.getAttribute('data-date');
        if (!date) return;

        let count = 0;
        let source = '';

        // Priority 1: Try aria-labelledby to find tooltip (GitHub's current structure)
        const ariaLabelledBy = el.getAttribute('aria-labelledby');
        if (ariaLabelledBy) {
          const tooltip = document.getElementById(ariaLabelledBy);
          if (tooltip && tooltip.textContent) {
            const text = tooltip.textContent.trim();
            // Format: "10 contributions on March 21, 2022" or "No contributions on March 20, 2022"
            const match = text.match(/^(\d+)\s+contribution/);
            if (match) {
              count = parseInt(match[1]) || 0;
              source = 'aria-labelledby';
              foundWithTooltip++;
            } else if (text.includes('No contribution')) {
              // Explicitly has no contributions, skip it
              skippedNoContributions++;
              return;
            }
          }
        }

        // Priority 2: Try aria-label attribute (fallback)
        if (count === 0) {
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) {
            if (ariaLabel.includes('No contribution')) {
              skippedNoContributions++;
              return;
            }
            const match = ariaLabel.match(/^(\d+)\s+contribution/);
            if (match) {
              count = parseInt(match[1]) || 0;
              source = 'aria-label';
              foundWithAriaLabel++;
            }
          }
        }

        // Priority 3: Try data-count attribute (fallback)
        if (count === 0) {
          const dataCount = el.getAttribute('data-count');
          if (dataCount) {
            count = parseInt(dataCount) || 0;
            source = 'data-count';
            foundWithDataCount++;
          }
        }

        // Priority 4: Try data-level as last resort (approximate)
        if (count === 0) {
          const dataLevel = el.getAttribute('data-level');
          if (dataLevel) {
            // Map levels to approximate counts (this is a fallback estimation)
            const levelMap = { '0': 0, '1': 2, '2': 5, '3': 10, '4': 15 };
            count = levelMap[dataLevel] || 0;
            source = 'data-level';
            foundWithDataLevel++;
          }
        }

        // Only add if we have contributions
        if (count > 0) {
          result.contributions.push({ date, count, source });
        }
      });

      result.stats = {
        foundWithTooltip,
        foundWithAriaLabel,
        foundWithDataCount,
        foundWithDataLevel,
        skippedNoContributions
      };

      return result;
    });

    debugLog(`Found ${contributionData.contributions.length} days with contributions`);
    debugLog('Extraction stats:', contributionData.stats);

    const totalExtracted = contributionData.contributions.reduce((sum, c) => sum + c.count, 0);
    console.log(`\nExtracted ${totalExtracted} contributions from ${contributionData.contributions.length} days`);
    
    if (contributionData.totalFromPage) {
      debugLog(`Total from page heading: ${contributionData.totalFromPage}`);
      if (totalExtracted === contributionData.totalFromPage) {
        console.log(`✅ Validation: Successfully captured all ${totalExtracted} contributions (100%)`);
      } else {
        const captureRate = ((totalExtracted / contributionData.totalFromPage) * 100).toFixed(1);
        console.log(`⚠️  Validation: Captured ${totalExtracted} of ${contributionData.totalFromPage} contributions (${captureRate}%)`);
        if (totalExtracted < contributionData.totalFromPage) {
          console.log(`   Missing ${contributionData.totalFromPage - totalExtracted} contributions`);
        }
      }
    }

    // Generate script BEFORE closing browser to avoid Yarn PnP crash
    console.log('\nGenerating script...');
    debugLog('Starting script generation with', contributionData.contributions.length, 'contributions');
    
    // Sort contributions by date to ensure chronological order
    const sortedContributions = contributionData.contributions.sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });
    
    console.log(`Sorted contributions from ${sortedContributions[0].date} to ${sortedContributions[sortedContributions.length - 1].date}`);
    
    // Check for existing contributions to enable incremental imports
    console.log('\nChecking for existing contributions...');
    const existingContributions = getExistingContributions();
    const existingCount = Object.values(existingContributions).reduce((sum, count) => sum + count, 0);
    const isIncremental = existingCount > 0;
    
    if (isIncremental) {
      console.log(`Found ${existingCount} existing contributions across ${Object.keys(existingContributions).length} days`);
    } else {
      console.log('No existing contributions found - performing full import');
    }
    
    // Filter to only new contributions (delta between scraped and existing)
    const newContributions = sortedContributions.map(contribution => {
      const existing = existingContributions[contribution.date] || 0;
      const newCount = contribution.count - existing;
      
      return {
        ...contribution,
        count: Math.max(0, newCount), // Only positive differences
        originalCount: contribution.count,
        existingCount: existing
      };
    }).filter(c => c.count > 0); // Only contributions with new commits
    
    const newTotalCount = newContributions.reduce((sum, c) => sum + c.count, 0);
    
    // Display incremental import summary
    console.log(`\n📊 Import Summary:`);
    console.log(`   Total scraped from GitHub: ${totalExtracted} contributions`);
    if (isIncremental) {
      console.log(`   Already imported: ${existingCount} contributions`);
      console.log(`   New to import: ${newTotalCount} contributions`);
      console.log(`   Dates affected: ${newContributions.length} days`);
      
      if (newTotalCount === 0) {
        console.log(`\n✅ All contributions already imported! No new commits needed.`);
        process.exit(0);
      }
    } else {
      console.log(`   New to import: ${newTotalCount} contributions (full import)`);
      console.log(`   Dates affected: ${newContributions.length} days`);
    }
    
    // Display batch information if enabled
    if (input.enableBatching) {
      const batchSize = parseInt(input.batchSize) || 500;
      const totalBatches = Math.ceil(newTotalCount / batchSize);
      const estimatedTime = totalBatches * parseInt(input.batchDelayMinutes || 5);
      console.log(`\n📦 Batch Import Configuration:`);
      console.log(`   Batch size: ${batchSize} contributions per batch`);
      console.log(`   Total batches: ${totalBatches}`);
      console.log(`   Delay between batches: ${input.batchDelayMinutes} minutes`);
      console.log(`   Estimated time: ~${estimatedTime} minutes`);
    }
    
    // Initialize contributions.txt file only on fresh import
    // With idempotency check to prevent re-initialization if script is run multiple times
    const initCommands = isIncremental 
      ? '' // Skip initialization if file already exists
      : `# Initialize contributions tracking file (with idempotency check)
if [ ! -f contributions.txt ] || [ ! -s contributions.txt ]; then
  echo "GitHub Contributions History" > contributions.txt
  git add contributions.txt
  git commit -m "Initialize contributions tracking"
fi

`;
    
    // Generate script with or without batching
    let script;
    if (input.enableBatching) {
      const batchSize = parseInt(input.batchSize) || 500;
      const delaySeconds = (parseInt(input.batchDelayMinutes) || 5) * 60;
      
      // Split contributions into batches based on total contribution count, not days
      let commandsArray = [];
      let currentBatchContributions = 0;
      let currentBatch = [];
      let batchNum = 1;
      const totalBatches = Math.ceil(newTotalCount / batchSize);
      
      for (let i = 0; i < newContributions.length; i++) {
        const contribution = newContributions[i];
        
        // If adding this day would exceed batch size, finalize current batch
        if (currentBatchContributions + contribution.count > batchSize && currentBatch.length > 0) {
          // Add batch header
          const batchContribCount = currentBatch.reduce((sum, c) => sum + c.count, 0);
          commandsArray.push(`\necho "========================================"`);
          commandsArray.push(`echo "Batch ${batchNum} of ${totalBatches}"`);
          commandsArray.push(`echo "Processing ${batchContribCount} contributions across ${currentBatch.length} days..."`);
          commandsArray.push(`echo "========================================\n"`);
          
          // Add commands for this batch
          currentBatch.forEach(contrib => {
            commandsArray.push(getCommand(contrib, input.personalName, input.personalEmail));
          });
          
          // Push this batch to GitHub
          commandsArray.push(`\necho "Pushing batch ${batchNum} to GitHub..."`);
          commandsArray.push(`git pull origin main`);
          commandsArray.push(`git push -f origin main`);
          commandsArray.push(`echo "Batch ${batchNum} pushed successfully!"`);
          
          // Add delay between batches (not after last batch)
          if (i < newContributions.length) {
            commandsArray.push(`\necho "Waiting ${input.batchDelayMinutes} minutes before next batch..."`);
            commandsArray.push(`sleep ${delaySeconds}\n`);
          }
          
          // Reset for next batch
          batchNum++;
          currentBatch = [];
          currentBatchContributions = 0;
        }
        
        // Add contribution to current batch
        currentBatch.push(contribution);
        currentBatchContributions += contribution.count;
      }
      
      // Finalize last batch
      if (currentBatch.length > 0) {
        const batchContribCount = currentBatch.reduce((sum, c) => sum + c.count, 0);
        commandsArray.push(`\necho "========================================"`);
        commandsArray.push(`echo "Batch ${batchNum} of ${totalBatches}"`);
        commandsArray.push(`echo "Processing ${batchContribCount} contributions across ${currentBatch.length} days..."`);
        commandsArray.push(`echo "========================================\n"`);
        
        currentBatch.forEach(contrib => {
          commandsArray.push(getCommand(contrib, input.personalName, input.personalEmail));
        });
        
        // Push final batch to GitHub
        commandsArray.push(`\necho "Pushing final batch ${batchNum} to GitHub..."`);
        commandsArray.push(`git pull origin main`);
        commandsArray.push(`git push -f origin main`);
        commandsArray.push(`echo "All batches complete! Successfully pushed ${newTotalCount} contributions."`);
      }
      
      script = initCommands + commandsArray.join("\n");
    } else {
      // Original non-batched approach
      script = initCommands + newContributions
        .map((contribution) => getCommand(contribution, input.personalName, input.personalEmail))
        .join("\n")
        .concat("\ngit pull origin main\n", "git push -f origin main");
    }

    console.log(`Script generated (${script.length} characters)`);

    // Write script file with error handling
    const scriptFilename = `${input.year}.sh`;
    console.log(`Writing ${scriptFilename} to disk...`);
    try {
      fs.writeFileSync(scriptFilename, script);
      console.log('writeFileSync completed');
      
      // Verify file was created
      if (fs.existsSync(scriptFilename)) {
        const stats = fs.statSync(scriptFilename);
        console.log(`\n✅ ${scriptFilename} created successfully (${stats.size} bytes, ${newContributions.length} days with new contributions)`);
        debugLog(`Script preview (first 500 chars):\n${script.substring(0, 500)}...`);
      } else {
        console.error(`ERROR: ${scriptFilename} does not exist after writeFileSync!`);
        throw new Error("File was not created");
      }
    } catch (err) {
      console.error(`Error writing ${scriptFilename}:`, err);
      throw err;
    }

    // Validation: Compare dates in script with extracted dates
    const scriptDates = new Set();
    const scriptContent = fs.readFileSync(scriptFilename, "utf-8");
    const dateMatches = scriptContent.matchAll(/GIT_AUTHOR_DATE="(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}[+-]\d{4}"/g);
    for (const match of dateMatches) {
      scriptDates.add(match[1]);
    }

    const extractedDates = new Set(contributionData.contributions.map(c => c.date));
    const missingDates = [];
    for (const date of extractedDates) {
      if (!scriptDates.has(date)) {
        missingDates.push(date);
      }
    }

    if (missingDates.length === 0) {
      console.log(`✅ Validation: All ${extractedDates.size} contribution dates are present in ${scriptFilename}`);
    } else {
      console.warn(`⚠️  Warning: ${missingDates.length} dates missing from ${scriptFilename}:`, missingDates.slice(0, 10));
    }

    if (input.execute) {
      console.log("\nExecuting script...");
      shell.exec(`sh ./${scriptFilename}`);
    } else {
      console.log(`\n✅ All done! You can now run: sh ./${scriptFilename}`);
    }

    // Exit immediately without closing browser - let OS clean up
    // This avoids Yarn PnP crash when browser.close() is called
    process.exit(0);

  } catch (error) {
    debugError('Error during execution:', error);
    console.error('Error:', error.message);
    
    if (browser) {
      await browser.close().catch(() => {
        // Ignore close errors
      });
    }
    
    throw error;
  }
};
