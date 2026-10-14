#!/usr/bin/env node
/**
 * NOKAR 2.0 — Static check: syntax-check every source file + smoke-require
 * the pure modules. Run with: npm run check
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const targets = [];

function collect (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'public', 'scripts'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.name.endsWith('.js')) targets.push(full);
  }
}

collect(ROOT);

let failed = 0;
for (const file of targets) {
  const rel = path.relative(ROOT, file);
  const res = spawnSync('node', ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    console.error(`❌ syntax error: ${rel}\n${res.stderr}`);
  } else {
    console.log(`✅ ${rel}`);
  }
}

// Smoke-require the pure modules (no bot needed)
try {
  const { parseCommand } = require(path.join(ROOT, 'lib/commands'));
  const t1 = parseCommand('mine iron 64');
  if (!t1 || t1.type !== 'mine' || t1.args.block !== 'iron' || t1.args.count !== 64) throw new Error('mine parse failed');
  const t2 = parseCommand('.goto 100 64 -200');
  if (!t2 || t2.type !== 'goto' || t2.args.x !== 100) throw new Error('goto parse failed');
  const t3 = parseCommand('guard on');
  if (!t3 || t3.type !== 'guard' || t3.args.on !== true) throw new Error('guard parse failed');
  console.log('✅ command parser smoke test');
} catch (err) {
  failed++;
  console.error('❌ command parser smoke test failed:', err.message);
}

// Goal-engine parsing: English + Hinglish
try {
  const { parseCommand } = require(path.join(ROOT, 'lib/commands'));
  const cases = [
    ['goal diamond 3', 'goal', 'diamond', 3],
    ['goal 64 iron', 'goal', 'iron', 64],
    ['diamond lao', 'goal', 'diamond', 1],
    ['iron 64 lao', 'goal', 'iron', 64],
    ['banao iron_pickaxe', 'craft', 'iron_pickaxe', 1],
    ['craft stick 8', 'craft', 'stick', 8],
    ['smelt iron_ingot 3', 'smelt', 'iron_ingot', 3],
    ['cook beef 2', 'smelt', 'beef', 2]
  ];
  for (const [text, type, item, count] of cases) {
    const p = parseCommand(text);
    if (!p || p.type !== type) throw new Error(`"${text}" → type ${p && p.type}`);
    if (p.args.item !== item) throw new Error(`"${text}" → item ${p.args.item} (want ${item})`);
    if (p.args.count !== count) throw new Error(`"${text}" → count ${p.args.count} (want ${count})`);
  }
  console.log('✅ goal/craft/smelt parsing (incl. Hinglish "X lao")');
} catch (err) {
  failed++;
  console.error('❌ goal parsing failed:', err.message);
}

// Owner matching: Bedrock ".Name" / "*Name" prefixes must match the plain owner name
try {
  const { normalizeOwner } = require(path.join(ROOT, 'lib/helpers'));
  const a = normalizeOwner('.DARSHPROGAMERZL');
  const b = normalizeOwner('*DARSHPROGAMERZL');
  const c = normalizeOwner('DARSHPROGAMERZL');
  if (a !== c || b !== c) throw new Error(`prefix strip failed: "${a}" / "${b}" vs "${c}"`);
  if (normalizeOwner('RandomGuy') === c) throw new Error('stranger matched as owner!');
  console.log('✅ owner matching (.Name / *Name → Name, strangers rejected)');
} catch (err) {
  failed++;
  console.error('❌ owner matching failed:', err.message);
}

// Planner: pickaxe tier requirement per block (data-driven)
try {
  const mcData = require('minecraft-data')('1.21.4');
  const { tierForBlocks } = require(path.join(ROOT, 'lib/goals'));
  const t = [
    [tierForBlocks(mcData, ['stone']), 'wooden'],
    [tierForBlocks(mcData, ['iron_ore', 'deepslate_iron_ore']), 'stone'],
    [tierForBlocks(mcData, ['diamond_ore', 'deepslate_diamond_ore']), 'iron'],
    [tierForBlocks(mcData, ['obsidian']), 'diamond']
  ];
  for (const [got, want] of t) if (got !== want) throw new Error(`tier ${got} != ${want}`);
  if (tierForBlocks(mcData, ['oak_log']) !== null) throw new Error('logs should need no pickaxe');
  console.log('✅ tool-tier planner (stone→wood, iron→stone, diamond→iron, obsidian→diamond)');
} catch (err) {
  failed++;
  console.error('❌ tool-tier planner failed:', err.message);
}

try {
  require(path.join(ROOT, 'lib/helpers'));
  require(path.join(ROOT, 'lib/config'));
  require(path.join(ROOT, 'lib/craft'));
  console.log('✅ helpers + config + craft load');
} catch (err) {
  failed++;
  console.error('❌ module load failed:', err.message);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed ✔');
