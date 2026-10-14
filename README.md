# NOKar 2.1 🤖⚔️⛏️💎

Ek **full-power Minecraft survival bot** — follow karta hai, ladta hai, mine karta hai, khana khata hai, khud ko bachata hai... aur ab **khud se crafting, smelting aur poore goals** bhi poore karta hai. Saath me ek **real-time web dashboard** (radar, inventory, mission control).

> **Highlights v2.1:** `goal diamond 3` bolo — bot khud ped kaatta hai → planks → table → wooden pickaxe → stone → stone pickaxe → iron mine → furnace → smelt → iron pickaxe → diamond nikaalta hai. Sab kuch **zero se, bina kisi help ke**. 💀

> Built on [mineflayer](https://github.com/PrismarineJS/mineflayer) + [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) + [mineflayer-collectblock](https://github.com/PrismarineJS/mineflayer-collectblock).
> Live-tested on **Paper 1.21.4**.

---

## ⚡ Quick Start

```bash
npm install
# config.json me apne server ki details bharo (host, port, username, owner)
npm start
```

Dashboard: **http://localhost:3000**

## 🎯 The Goal Engine (v2.1 ka dil)

Ek hi command, koi bhi cheez:

```
goal diamond 3        /  diamond 3 lao
goal iron_ingot 64    /  iron 64 lao
goal torch 64
goal obsidian 10
banao iron_pickaxe    /  craft stick 8
smelt iron_ingot 3    /  cook beef 2
```

Bot khud plan banata hai — recipe/tool-chain khud samajhta hai:

```
wood → planks → crafting table → wooden pickaxe → stone →
stone pickaxe → iron ore → furnace → smelt → iron pickaxe → 💎 diamond
```

- **Tool tiers khud**: har block ke liye sahi tier wala pickaxe pehle banata hai (spawner/registry data se)
- **Ore neeche ho to staircase khodta hai** (Y=-59 tak, lava se bachte hue)
- **Smelting khud**: furnace banata hai, fuel (coal/planks) jama karta hai, output uthata hai
- **Har cheez ke liye**: block, ore, item, tool, torch, bed... jo bologe

## 📋 Full Feature List

| Skill | Kya karta hai |
|---|---|
| **🎯 Goal Engine** | `goal <kuch bhi> [count]` — mining + crafting + smelting + digging chain khud plan karke poora karta hai |
| **🔨 Crafting** | Koi bhi recipe (2x2 + 3x3 table), ingredients khud jama karta hai, table khud place karta hai |
| **♨️ Smelting** | Furnace khud banata/lagata hai, fuel khud, output khud uthata hai |
| **⛏️ Mining** | `mine stone 64` — har block, tool auto-switch, explore, drop counting |
| **🪓 Chopping** | `chop 32` — har tarah ki lakdi |
| **⚔️ Combat** | Best weapon auto, strafe + jump-crit, low HP disengage, 90s timeout |
| **🛡️ Guard Mode** | Aas-paas mob aate hi khud defend |
| **🏃 Follow / Goto** | Player ke peeche, ya coordinates pe, doors/stairs handled |
| **🍗 Auto-Eat** | Bhookh kam → best food khud |
| **💥 Survival Reflexes** | Creeper/lava se bach, low HP flee, retaliation, anti-AFK, auto-respawn |
| **🔐 Auto-Login** | /login + /register khud (AuthMe waghera) |
| **🖥️ Dashboard** | Live radar, inventory, mission control, goal button, manual D-pad |

## 🕹️ Commands (owner only)

Chat me type karo (ya dashboard ke command box me) — **English + Hinglish dono**:

```
follow <player>        come                    stop
guard on|off           attack <name|nearest>   flee
mine <block> <count>   chop [count]            goto <x> [y] <z>
goal <item> [count]    craft <item> [count]    smelt <item> [count]
eat                    toss <item> [count]     dropall
afk on|off             status                  where
help
```

Hinglish bhi chalta hai: `diamond lao`, `iron 64 lao`, `banao iron_pickaxe`

> **Bedrock (Geyser/Floodgate) players:** naam `.DARSHPROGAMERZL` ya `*Name` dikhta hai to bhi commands kaam karenge — prefix khud strip ho jata hai.

## ⚙️ Configuration

`config.json` (ya env vars):

```json
{
  "webPort": 3000,
  "dashboardPassword": "",
  "mc": {
    "host": "your-server.aternos.me",
    "port": 62974,
    "username": "Nokar",
    "version": "1.21.4",
    "password": "",
    "owner": "DARSHPROGAMERZL",
    "reconnectDelayMs": 20000
  },
  "behavior": {
    "autoEatAt": 14, "critEatAt": 20, "fleeHealth": 7,
    "guardRange": 12, "antiAfk": true, "tossJunkWhenFull": true
  }
}
```

Env overrides: `PORT`, `DASH_PASSWORD`, `MC_HOST`, `MC_PORT`, `MC_NAME`, `MC_VERSION`, `MC_PASSWORD`, `MC_OWNER`.
Secrets ke liye `config.local.json` banao (git-ignored) — env > `config.local.json` > `config.json`.

### ⚠️ Security

- `dashboardPassword` **khaali = dashboard OPEN** — internet par expose karne se pehle password set karo.
- In-game commands sirf `owner` username se chalte hain.

## 🧪 Testing

```bash
npm run check    # syntax + parser + planner unit checks (offline, fast)

# Live tests (chalti hui Paper server ke against, RCON ke through):
node scripts/livetest2.js   # core skills: mine/chop/combat/follow/eat/goto/stop
node scripts/livetest3.js   # GOAL ENGINE: zero → diamond chain, torch, staircase, owner-prefix
```

`livetest3` full board: goal diamond (chain milestones), goal torch, staircase descent, owner `.Name` matching, STOP safety.

## 📁 Structure

```
index.js            — entry (config → engine → dashboard)
lib/
  config.js         — config loader + env overrides
  engine.js         — lifecycle, reconnect, auto-login, owner commands, snapshot
  brain.js          — task queue + state machine
  skills.js         — follow/come/goto/mine/chop/attack/flee + adaptive block collector
  craft.js          — crafting (window-click based) + smelting (furnace API)  ← v2.1
  goals.js          — the planner: goal chain, tool tiers, staircase descent   ← v2.1
  survival.js       — reflexes (eat, creeper/lava, low HP, retaliation)
  commands.js       — parser (EN + Hinglish) + aliases + help
  helpers.js        — tools/weapons, drops, owner-name normalize, delays
  dashboard.js      — Express + Socket.IO
public/             — dashboard UI
scripts/            — check.js + livetest2/livetest3
```

## 📦 Requirements

- **Node.js** 18+
- Minecraft server **1.21.4** (config me `version` sahi rakho)
- Offline-mode server: `password` khaali. AuthMe: password daalo → auto `/login`.

## ❤️ Credits

Originally forked from [mineflayer-web-inventory](https://github.com/PrismarineJS/mineflayer-web-inventory) — ab poora **NOKAR** bot engine hai.
