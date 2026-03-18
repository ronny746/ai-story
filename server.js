const express = require("express");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");
const https = require("https");

const app = express();
app.use(express.json());

const MOODS = {
    normal: { bgm: "none", vol: 0.1 },
    horror: { bgm: "horror", vol: 0.28 },
    mystery: { bgm: "mystery", vol: 0.22 },
    happy: { bgm: "happy", vol: 0.15 }
};

const OUTPUT = path.join(__dirname, "output");
const TEMP = path.join(__dirname, "temp_universal_stable");
const BGM_DIR = path.join(__dirname, "assets", "bgm");
const SFX_DIR = path.join(__dirname, "assets", "sfx");
[OUTPUT, TEMP, BGM_DIR, SFX_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

function uid() { return Date.now() + "_" + Math.floor(Math.random() * 1000); }

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function splitText(text, limit = 150) {
    const chunks = [];
    const sentences = text.replace(/([।\.!\?\n])/g, "$1|").split("|");
    let current = "";
    for (let s of sentences) {
        if ((current + s).length > limit) {
            if (current) chunks.push(current.trim());
            current = s;
        } else {
            current += s;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

async function downloadGTTS(text, filepath) {
    return new Promise((resolve, reject) => {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text.substring(0, 200))}&tl=hi&client=tw-ob`;
        const file = fs.createWriteStream(filepath);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`Google Error: ${res.statusCode}`));
                return;
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
    });
}

function getSFXTrigger(text) {
    if (text.includes("बारिश")) return "rain.mp3";
    if (text.includes("दरवाजा")) return "door.mp3";
    if (text.includes("खटखटाया")) return "knock.mp3";
    if (text.includes("कदम")) return "footsteps.mp3";
    if (text.includes("धड़कen")) return "heartbeat.mp3";
    return null;
}

app.post("/tts-single", async (req, res) => {
    const { text, mood, mode, speaker } = req.body;
    if (!text) return res.status(400).json({ error: "No text" });
    
    const sessionId = uid();
    const sessionDir = path.join(TEMP, sessionId);
    fs.mkdirSync(sessionDir);

    const config = MOODS[mood] || MOODS.normal;
    const finalMp3 = path.join(OUTPUT, `${sessionId}.mp3`);
    const timeline = [];

    try {
        if (mode === 'auto') {
            const lines = text.split('\n').filter(l => l.trim().length > 1);
            let chunkCounter = 0;

            for (let line of lines) {
                let speedScale = 1.0;
                let cleanLine = line;

                if (line.match(/अजय\s*[:|-]/)) { speedScale = 1.1; cleanLine = line.replace(/अजय\s*[:|-]/, "").trim(); }
                else if (line.match(/बूढ़ा आदमी\s*[:|-]|बूढ़ा\s*[:|-]/)) { speedScale = 0.8; cleanLine = line.replace(/.*[:|-]/, "").trim(); }

                const subChunks = splitText(cleanLine, 150);
                for (let sub of subChunks) {
                    const rp = path.join(sessionDir, `p_${chunkCounter}.mp3`);
                    const sp = path.join(sessionDir, `s_${chunkCounter}.mp3`);
                    await downloadGTTS(sub, rp);
                    execSync(`ffmpeg -y -i "${rp}" -filter:a "atempo=${speedScale}" "${sp}"`, {stdio: 'ignore'});
                    timeline.push(sp);
                    await wait(400); 
                    chunkCounter++;
                }

                // Inject SFX based on current line content
                const sfx = getSFXTrigger(line);
                if (sfx && fs.existsSync(path.join(SFX_DIR, sfx))) {
                    timeline.push(path.join(SFX_DIR, sfx));
                }
                
                const gap = path.join(sessionDir, `g_${chunkCounter}.mp3`);
                execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 0.8 "${gap}"`, {stdio:'ignore'});
                timeline.push(gap);
            }

            const listFile = path.join(sessionDir, "list.txt");
            fs.writeFileSync(listFile, timeline.map(f => `file '${f}'`).join('\n'));
            const rawMaster = path.join(sessionDir, "raw.mp3");
            execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${rawMaster}"`, {stdio:'ignore'});
            
            const bgm = path.join(BGM_DIR, `${config.bgm}.mp3`);
            if (config.bgm !== "none" && fs.existsSync(bgm)) {
                execSync(`ffmpeg -y -i "${rawMaster}" -i "${bgm}" -filter_complex "[1:a]aloop=loop=-1:size=2e9,volume=${config.vol}[bgm];[0:a][bgm]amix=inputs=2:duration=first[out]" -map "[out]" "${finalMp3}"`, {stdio:'ignore'});
            } else { fs.copyFileSync(rawMaster, finalMp3); }

        } else {
            let speed = (speaker === 'oldman') ? 0.8 : (speaker === 'ajay' ? 1.1 : 1.0);
            const rp = path.join(sessionDir, `r.mp3`);
            await downloadGTTS(text, rp);
            execSync(`ffmpeg -y -i "${rp}" -filter:a "atempo=${speed}" "${finalMp3}"`, {stdio: 'ignore'});
        }

        fs.rmSync(sessionDir, { recursive: true, force: true });
        res.json({ success: true, url: `/output/${sessionId}.mp3` });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: "Production failed" }); 
    }
});

app.delete("/api/audio/:id", (req, res) => {
    const p = path.join(OUTPUT, `${req.params.id}.mp3`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ success: true });
});

app.use("/output", express.static(OUTPUT));

app.get("/", (req, res) => {
    const audioFiles = fs.readdirSync(OUTPUT).filter(f => f.endsWith(".mp3")).sort((a,b) => fs.statSync(path.join(OUTPUT, b)).mtime - fs.statSync(path.join(OUTPUT, a)).mtime);
    const listHtml = audioFiles.map(f => `<div class="audio-card"><div class="audio-info"><h3>Production Record</h3><p>${f.substring(0,10)}...</p></div><audio controls src="/output/${f}"></audio><button class="del-btn" onclick="del('${f.replace(".mp3","")}')">×</button></div>`).join("");

    res.send(`<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><title>StoryStudio | Stable VPS</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #030712; --card: rgba(17, 24, 39, 0.95); --accent: #38bdf8; --text: #f1f5f9; --danger: #f43f5e; }
            body { background: var(--bg); color: var(--text); font-family: 'Outfit', sans-serif; padding: 40px 20px; }
            .container { max-width: 850px; margin: 0 auto; }
            .tabs { display: flex; gap: 8px; margin-bottom: 25px; }
            .tab-btn { flex: 1; padding: 15px; background: rgba(255,255,255,0.03); border: none; border-radius: 12px; color: #64748b; cursor: pointer; font-weight: 800; }
            .tab-btn.active { background: var(--accent); color: #030712; }
            .content { display: none; background: var(--card); border-radius: 28px; padding: 40px; border: 1px solid rgba(255,255,255,0.05); }
            .content.active { display: block; }
            textarea { width: 100%; min-height: 250px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); border-radius: 18px; padding: 25px; color: white; margin-bottom: 25px; font-family: inherit; line-height: 1.8; font-size: 1.05rem; }
            .btn { width: 100%; padding: 20px; border-radius: 15px; border: none; font-weight: 800; cursor: pointer; background: var(--accent); color: #030712; font-size: 1.2rem; }
            .mood-bar { display: flex; gap: 8px; margin-bottom: 25px; background: rgba(0,0,0,0.4); padding: 5px; border-radius: 14px; }
            .m-btn { flex: 1; padding: 12px; border: none; background: none; color: #94a3b8; cursor: pointer; border-radius: 10px; font-weight: 700; font-size: 11px; }
            .m-btn.active { background: white; color: #030712; }
            .audio-card { background: rgba(255,255,255,0.02); padding: 20px; border-radius: 20px; margin-top: 15px; display: flex; align-items: center; gap: 15px; border: 1px solid rgba(255,255,255,0.03); }
            audio { flex: 1; filter: invert(0.9); }
        </style>
    </head>
    <body class="container">
        <h1 style="text-align:center; font-weight:900; margin-bottom:50px;">STUDIO<span style="color:var(--accent)">PRO</span> VPS</h1>
        
        <div class="tabs">
            <button class="tab-btn active" onclick="sh('mix')">AUTO MIX 🎬</button>
            <button class="tab-btn" onclick="sh('nar')">NARRATION</button>
            <button class="tab-btn" onclick="sh('ajay')">AJAY</button>
            <button class="tab-btn" onclick="sh('old')">OLD MAN</button>
        </div>

        <div id="mix" class="content active">
            <textarea id="t_mix" placeholder="Paste full script... Ajay: and Boodha:"></textarea>
            <div class="mood-bar">
                <button class="m-btn active" id="m-normal" onclick="pick('normal')">NORMAL</button>
                <button class="m-btn" id="m-horror" onclick="pick('horror')">HORROR</button>
                <button class="m-btn" id="m-mystery" onclick="pick('mystery')">MYSTERY</button>
                <button class="m-btn" id="m-happy" onclick="pick('happy')">HAPPY</button>
            </div>
            <button class="btn" onclick="gen('auto')">PRODUCE FULL CHAPTER</button>
        </div>

        <div id="nar" class="content"><textarea id="t_nar"></textarea><button class="btn" onclick="gen('nar')">NARRATION</button></div>
        <div id="ajay" class="content"><textarea id="t_ajay"></textarea><button class="btn" onclick="gen('ajay')">AJAY VOICE</button></div>
        <div id="old" class="content"><textarea id="t_old"></textarea><button class="btn" onclick="gen('oldman')">OLD MAN VOICE</button></div>

        <div id="status" style="text-align:center; margin-top:30px; color:var(--accent); font-weight:800"></div>
        <div id="recs">${listHtml}</div>

        <script>
            let mood = 'normal';
            function sh(id) {
                document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.getElementById(id).classList.add('active');
                event.currentTarget.classList.add('active');
            }
            function pick(m) {
                mood = m;
                document.querySelectorAll('.m-btn').forEach(b => b.classList.remove('active'));
                document.getElementById('m-' + m).classList.add('active');
            }
            async function gen(sp) {
                const text = document.getElementById('t_' + (sp === 'auto' ? 'mix' : (sp === 'oldman' ? 'old' : sp))).value.trim();
                if(!text) return;
                document.getElementById('status').innerText = "Processing Stable Neural Voice...";
                const res = await fetch('/tts-single', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, mood, mode: (sp==='auto'?'auto':'solo'), speaker: sp })
                });
                if ((await res.json()).success) location.reload();
            }
            async function del(id) { if(confirm("Discard?")) { await fetch('/api/audio/' + id, {method:'DELETE'}); location.reload(); } }
        </script>
    </body></html>`);
});

app.listen(3000, () => console.log("🚀 Stable Cinema Online"));