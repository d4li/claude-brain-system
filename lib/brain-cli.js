#!/usr/bin/env node

/**
 * Claude Brain CLI - Interface de comando para o Brain System
 */

const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const { BrainCore, TaskManager } = require('./brain');

// Version from package.json
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
const version = packageJson.version;

// CLI State
let brainCore = null;
let taskManager = null;

// Helper to ensure brain is initialized
async function ensureBrain() {
  if (!brainCore) {
    brainCore = new BrainCore();
    taskManager = new TaskManager({
      stateManager: brainCore.stateManager,
      protocol: brainCore.protocol
    });

    await brainCore.loadAll();
  }
  return brainCore;
}

// Helper to format output
function formatOutput(data, format = 'json') {
  switch (format) {
    case 'json-pretty':
      return JSON.stringify(data, null, 2);
    case 'yaml':
      // Simple YAML-like format
      return Object.entries(data)
        .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join('\n');
    default:
      return JSON.stringify(data);
  }
}

// Configure CLI
program
  .name('claude-brain')
  .description('Brain System CLI for multi-terminal coordination')
  .version(version);

// Daemon commands
program
  .command('daemon')
  .description('Manage the Brain daemon')
  .addCommand(
    program.createCommand('start')
      .description('Start the Brain daemon')
      .option('-d, --detach', 'Run in detached mode (background)')
      .action(async (options) => {
        const brain = new BrainCore();
        await brain.start();

        console.log('Brain daemon started');
        console.log('Info:', JSON.stringify(brain.getInfo(), null, 2));

        if (!options.detach) {
          console.log('Press Ctrl+C to stop...');
          process.on('SIGINT', async () => {
            console.log('\nStopping Brain daemon...');
            await brain.stop();
            process.exit(0);
          });
        } else {
          // Save PID and exit
          const pidFile = path.join('.claude-brain', 'brain.pid');
          fs.writeFileSync(pidFile, String(process.pid));
          console.log('Daemon running in background, PID:', process.pid);
          process.exit(0);
        }
      })
  )
  .addCommand(
    program.createCommand('stop')
      .description('Stop the Brain daemon')
      .action(async () => {
        const pidFile = path.join('.claude-brain', 'brain.pid');
        if (fs.existsSync(pidFile)) {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
          try {
            process.kill(pid, 'SIGTERM');
            console.log('Brain daemon stopped');
            fs.unlinkSync(pidFile);
          } catch (err) {
            console.error('Failed to stop daemon:', err.message);
          }
        } else {
          console.log('No daemon running (no PID file found)');
        }
      })
  )
  .addCommand(
    program.createCommand('status')
      .description('Show daemon status')
      .action(async () => {
        const brain = await ensureBrain();
        const info = brain.getInfo();
        console.log(formatOutput(info, 'json-pretty'));
      })
  );

// Terminal commands
program
  .command('terminal')
  .description('Manage terminals')
  .addCommand(
    program.createCommand('list')
      .description('List all terminals')
      .option('-f, --format <format>', 'Output format', 'json-pretty')
      .action(async (options) => {
        const brain = await ensureBrain();
        const terminals = await brain.getTerminals();
        console.log(formatOutput(terminals, options.format));
      })
  )
  .addCommand(
    program.createCommand('status')
      .description('Show terminal status')
      .argument('<name>', 'Terminal name')
      .action(async (name) => {
        const brain = await ensureBrain();
        const terminal = await brain.stateManager.get(`terminal.${name}`);
        if (!terminal) {
          console.error('Terminal not found:', name);
          process.exit(1);
        }
        console.log(formatOutput(terminal, 'json-pretty'));
      })
  );

// Task commands
program
  .command('task')
  .description('Manage tasks')
  .addCommand(
    program.createCommand('list')
      .description('List tasks')
      .option('-s, --status <status>', 'Filter by status')
      .option('-a, --area <area>', 'Filter by area')
      .option('-o, --owner <owner>', 'Filter by owner')
      .option('-c, --creator <creator>', 'Filter by creator')
      .option('-l, --limit <limit>', 'Limit results', '50')
      .option('--offset <offset>', 'Offset for pagination', '0')
      .option('-f, --format <format>', 'Output format', 'json-pretty')
      .action(async (options) => {
        await ensureBrain();
        const result = await taskManager.list({
          status: options.status,
          area: options.area,
          owner: options.owner,
          creator: options.creator,
          limit: parseInt(options.limit),
          offset: parseInt(options.offset)
        });
        console.log(formatOutput(result, options.format));
      })
  )
  .addCommand(
    program.createCommand('create')
      .description('Create a new task')
      .argument('<subject>', 'Task subject')
      .option('-d, --description <description>', 'Task description')
      .option('-a, --area <area>', 'Task area (ux, frontend, backend, qa)')
      .option('-p, --priority <priority>', 'Task priority (1-5)', '3')
      .option('--creator <creator>', 'Task creator', 'cli')
      .option('-t, --tag <tag...>', 'Task tags')
      .action(async (subject, options) => {
        await ensureBrain();
        const task = await taskManager.create({
          subject,
          description: options.description || '',
          priority: parseInt(options.priority),
          creator: options.creator,
          metadata: { area: options.area },
          tags: options.tag || []
        });
        console.log('Task created:', task.id);
        console.log(formatOutput(task, 'json-pretty'));
      })
  )
  .addCommand(
    program.createCommand('get')
      .description('Get task details')
      .argument('<task-id>', 'Task ID')
      .action(async (taskId) => {
        await ensureBrain();
        const task = await taskManager.get(taskId);
        if (!task) {
          console.error('Task not found:', taskId);
          process.exit(1);
        }
        console.log(formatOutput(task, 'json-pretty'));
      })
  )
  .addCommand(
    program.createCommand('update')
      .description('Update task')
      .argument('<task-id>', 'Task ID')
      .option('-s, --status <status>', 'Update status')
      .option('-o, --owner <owner>', 'Assign to terminal')
      .option('-p, --priority <priority>', 'Update priority')
      .action(async (taskId, options) => {
        await ensureBrain();
        const updates = {};
        if (options.status) updates.status = options.status;
        if (options.owner) updates.owner = options.owner;
        if (options.priority) updates.priority = parseInt(options.priority);

        const task = await taskManager.update(taskId, updates);
        console.log('Task updated:', task.id);
        console.log(formatOutput(task, 'json-pretty'));
      })
  );

// State commands
program
  .command('state')
  .description('Manage state')
  .addCommand(
    program.createCommand('get')
      .description('Get state value')
      .argument('<key>', 'State key')
      .action(async (key) => {
        await ensureBrain();
        const value = await brainCore.stateManager.get(key);
        console.log(formatOutput(value !== undefined ? value : null, 'json-pretty'));
      })
  )
  .addCommand(
    program.createCommand('set')
      .description('Set state value')
      .argument('<key>', 'State key')
      .argument('<value>', 'State value (JSON string)')
      .action(async (key, value) => {
        await ensureBrain();
        let parsedValue;
        try {
          parsedValue = JSON.parse(value);
        } catch (err) {
          parsedValue = value; // Treat as plain string
        }
        await brainCore.stateManager.set(key, parsedValue);
        console.log('State set:', key);
      })
  );

// Session commands
program
  .command('session')
  .description('Manage sessions')
  .addCommand(
    program.createCommand('current')
      .description('Show current session')
      .action(async () => {
        await ensureBrain();
        const sessionId = await brainCore.stateManager.getCurrentSession();
        if (!sessionId) {
          console.log('No active session');
          return;
        }
        const session = await brainCore.stateManager.getSessionInfo(sessionId);
        console.log(formatOutput({ sessionId, ...session }, 'json-pretty'));
      })
  );

// Run CLI
program.parseAsync().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
