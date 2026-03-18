const express = require("express");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const ffmpeg = require("fluent-ffmpeg");

const app = express();
app.use(express.json());

const MOODS = {
    normal: { bgm: "none", vol: 0.1 },
    horror: { bgm: "horror", vol: 0.28 },
    mystery: { bgm: "mystery", vol: 0.22 },
    happy: { bgm: "happy", vol: 0.15 }
};

const OUTPUT = path.join(__dirname, "output");
const TEMP = path.join(__dirname, "temp_studio_v3");
const BGM_DIR = path.join(__dirname, "assets", "bgm");
const SFX_DIR = path.join(__dirname, "assets", "sfx");
[OUTPUT, TEMP, BGM_DIR, SFX_DIR].forEach(dir => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); });

function uid() { return Date.now() + "_" + Math.floor(Math.random() * 1000); }

// 🔹 Smart SFX Trigger (Keyword based)
function getSFXTrigger(text) {
    if (text.includes("बारिश") || text.includes("बूँदें")) return "rain.mp3";
    if (text.includes("दरवाजा") || text.includes("खिड़की") || text.includes("अलमारी")) return "door.mp3";
    if (text.includes("खटखटाया") || text.includes("दस्तक")) return "knock.mp3";
    if (text.includes("चला") || text.includes("कदम") || text.includes("रास्ते") || text.includes("उतरा")) return "footsteps.mp3";
    if (text.includes("धड़कन") || text.includes("दिल") || text.includes("तेज़")) return "heartbeat.mp3";
    return null;
}

app.post("/tts-single", async (req, res) => {
    const { text, mood, mode, speaker } = req.body;
    if (!text) return res.status(400).json({ error: "Empty" });
    
    const sessionId = uid();
    const sessionDir = path.join(TEMP, sessionId);
    fs.mkdirSync(sessionDir);

    const config = MOODS[mood] || MOODS.normal;
    const finalMp3 = path.join(OUTPUT, `${sessionId}.mp3`);
    const timeline = [];

    try {
        if (mode === 'auto') {
            console.log(`🎬 Smart Cinematic Mix Start: ${sessionId}`);
            const lines = text.split('\n').filter(l => l.trim().length > 1);

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                let voice = "Lekha";
                let rate = 145;

                // Character Detect
                if (line.match(/अजय\s*[:|-]/)) { voice = "Aman"; rate = 155; line = line.replace(/अजय\s*[:|-]/, "").trim(); }
                else if (line.match(/बूढ़ा आदमी\s*[:|-]|बूढ़ा\s*[:|-]/)) { voice = "Aman"; rate = 110; line = line.replace(/.*[:|-]/, "").trim(); }

                const cAiff = path.join(sessionDir, `c_${i}.aiff`);
                const cMp3 = path.join(sessionDir, `c_${i}.mp3`);
                execSync(`say -v "${voice}" -r ${rate} -o "${cAiff}" "${line.replace(/"/g, '')}"`);
                execSync(`ffmpeg -y -i "${cAiff}" -codec:a libmp3lame -qscale:a 2 "${cMp3}"`, {stdio:'ignore'});
                timeline.push(cMp3);

                // 🔹 Smart SFX Injection
                const sfxAsset = getSFXTrigger(lines[i]);
                if (sfxAsset && fs.existsSync(path.join(SFX_DIR, sfxAsset)) && fs.statSync(path.join(SFX_DIR, sfxAsset)).size > 1000) {
                    const sfxPath = path.join(SFX_DIR, sfxAsset);
                    console.log(`🔊 Injected SFX: ${sfxAsset}`);
                    timeline.push(sfxPath);
                }

                // Gap
                const gap = path.join(sessionDir, `g_${i}.mp3`);
                execSync(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 0.6 "${gap}"`, {stdio:'ignore'});
                timeline.push(gap);
            }

            const listFile = path.join(sessionDir, "list.txt");
            fs.writeFileSync(listFile, timeline.map(f => `file '${f}'`).join('\n'));
            const raw = path.join(sessionDir, "raw.mp3");
            execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${raw}"`, {stdio:'ignore'});
            
            const bgm = path.join(BGM_DIR, `${config.bgm}.mp3`);
            if (config.bgm !== "none" && fs.existsSync(bgm)) {
                execSync(`ffmpeg -y -i "${raw}" -i "${bgm}" -filter_complex "[1:a]aloop=loop=-1:size=2e9,volume=${config.vol}[bgm];[0:a][bgm]amix=inputs=2:duration=first[out]" -map "[out]" "${finalMp3}"`, {stdio:'ignore'});
            } else { fs.copyFileSync(raw, finalMp3); }
            
        } else {
            // Solo Mode
            let voice = (speaker === 'ajay' || speaker === 'oldman') ? "Aman" : "Lekha";
            let rate = (speaker === 'oldman') ? 110 : (speaker === 'ajay' ? 155 : 145);
            const sAiff = path.join(sessionDir, `s.aiff`);
            execSync(`say -v "${voice}" -r ${rate} -o "${sAiff}" "${text.replace(/"/g, '')}"`);
            execSync(`ffmpeg -y -i "${sAiff}" -codec:a libmp3lame -qscale:a 2 "${finalMp3}"`, {stdio:'ignore'});
        }

        fs.rmSync(sessionDir, { recursive: true, force: true });
        res.json({ success: true, url: `/output/${sessionId}.mp3` });

    } catch (err) { res.status(500).json({ error: "Fail" }); }
});

app.delete("/api/audio/:id", (req, res) => {
    const p = path.join(OUTPUT, `${req.params.id}.mp3`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    res.json({ success: true });
});

app.use("/output", express.static(OUTPUT));

app.get("/", (req, res) => {
    const audioFiles = fs.readdirSync(OUTPUT).filter(f => f.endsWith(".mp3")).sort((a,b) => fs.statSync(path.join(OUTPUT, b)).mtime - fs.statSync(path.join(OUTPUT, a)).mtime);
    const listHtml = audioFiles.map(f => `<div class="audio-card"><div class="audio-info"><h3>Cinetic Mix</h3><p>${f.substring(0,10)}...</p></div><audio controls src="/output/${f}"></audio><button class="del-btn" onclick="del('${f.replace(".mp3","")}')">×</button></div>`).join("");

    res.send(`<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8"><title>StoryStudio | Smart SFX</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;700&display=swap" rel="stylesheet">
        <style>
            :root { --bg: #020617; --card: rgba(15, 23, 42, 0.9); --accent: #10b981; --text: #f1f5f9; --danger: #f43f5e; }
            body { background: var(--bg); color: var(--text); font-family: 'Outfit', sans-serif; padding: 40px 20px; }
            .container { max-width: 850px; margin: 0 auto; }
            .tabs { display: flex; gap: 8px; margin-bottom: 25px; }
            .tab-btn { flex: 1; padding: 16px; background: rgba(255,255,255,0.03); border: none; border-radius: 14px; color: #64748b; cursor: pointer; font-weight: 800; }
            .tab-btn.active { background: var(--accent); color: #020617; }
            .content { display: none; background: var(--card); border-radius: 32px; padding: 40px; border: 1px solid rgba(255,255,255,0.05); }
            .content.active { display: block; }
            textarea { width: 100%; min-height: 250px; background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.05); border-radius: 20px; padding: 25px; color: white; margin-bottom: 25px; font-family: inherit; line-height: 1.8; font-size: 1.05rem; }
            .btn { width: 100%; padding: 20px; border-radius: 16px; border: none; font-weight: 800; cursor: pointer; background: var(--accent); color: #020617; font-size: 1.2rem; }
            .mood-bar { display: flex; gap: 8px; margin-bottom: 25px; background: rgba(0,0,0,0.4); padding: 5px; border-radius: 14px; }
            .m-btn { flex: 1; padding: 12px; border: none; background: none; color: #94a3b8; cursor: pointer; border-radius: 10px; font-weight: 700; font-size: 11px; }
            .m-btn.active { background: white; color: #020617; }
            .sfx-hint { background: rgba(16,185,129,0.1); padding: 15px; border-radius: 14px; color: #10b981; font-size: 13px; margin-bottom: 20px; border: 1px dashed #10b981; }
            .audio-card { background: rgba(255,255,255,0.02); padding: 22px; border-radius: 24px; margin-top: 15px; display: flex; align-items: center; gap: 15px; border: 1px solid rgba(255,255,255,0.03); }
            audio { flex: 1; }
        </style>
    </head>
    <body class="container">
        <h1 style="text-align:center; font-weight:900; margin-bottom:50px; letter-spacing: 2px;">CINEMATIC<span style="color:var(--accent)">STUDIO</span> PRO</h1>
        
        <div class="tabs">
            <button class="tab-btn active" onclick="sh('mix')">AUTO MIX (SFX ENABLED) 🔥</button>
            <button class="tab-btn" onclick="sh('nar')">NARRATION</button>
            <button class="tab-btn" onclick="sh('ajay')">AJAY</button>
            <button class="tab-btn" onclick="sh('old')">OLD MAN</button>
        </div>

        <div id="mix" class="content active">
            <div class="sfx-hint">🚀 <b>Smart SFX Mode Active:</b> Use words like <i>'बारिश', 'दरवाजा', 'खटखटाया', 'कदम', 'धड़कन'</i> in your story for automatic sound effects!</div>
            <textarea id="t_mix" placeholder="Paste full script with Ajay: and Boodha: ..."></textarea>
            <div class="mood-bar">
                <button class="m-btn active" id="m-normal" onclick="pick('normal')">NORMAL</button>
                <button class="m-btn" id="m-horror" onclick="pick('horror')">HORROR</button>
                <button class="m-btn" id="m-mystery" onclick="pick('mystery')">MYSTERY</button>
                <button class="m-btn" id="m-happy" onclick="pick('happy')">HAPPY</button>
            </div>
            <button class="btn" onclick="gen('auto')">PRODUCE CINEMATIC CHAPTER</button>
        </div>

        <div id="nar" class="content">
            <textarea id="t_nar" placeholder="Narrator voice..."></textarea>
            <button class="btn" onclick="gen('nar')">PRODUCE TARA VOICE</button>
        </div>

        <div id="ajay" class="content">
            <textarea id="t_ajay" placeholder="Ajay's voice..."></textarea>
            <button class="btn" onclick="gen('ajay')">PRODUCE AMAN (BOY)</button>
        </div>

        <div id="old" class="content">
            <textarea id="t_old" placeholder="Old man's voice..."></textarea>
            <button class="btn" onclick="gen('oldman')">PRODUCE AMAN (OLD)</button>
        </div>

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
                document.getElementById('status').innerText = "🎭 Understanding Story & Injecting Cinematic SFX...";
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

app.listen(3000, () => console.log("🚀 Cinematic Studio Online"));