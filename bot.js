require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { Resend } = require('resend');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '8644507123:AAEmJWL6cO1-2UNZaJsMPVYYdHqCsIEAoPE';
const OWNER_ID = 6056192167;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ilbqrkswjqjbzvesivgk.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlsYnFya3N3anFqYnp2ZXNpdmdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MjEwMDcsImV4cCI6MjA4ODk5NzAwN30.vBvbE5F5tdRjlrP5iJF68ofS28B6QgyJU-p8SDc7rM4';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── SUPABASE ──────────────────────────────────────────────────────────────────

async function getScripts() {
    const { data, error } = await supabase
        .from('scripts')
        .select('*')
        .order('created_at', { ascending: true });
    if (error) { console.error('getScripts:', error.message); return []; }
    return data || [];
}

async function saveScript(script) {
    const { error } = await supabase.from('scripts').upsert({
        id: script.id,
        name: script.name,
        template_file: script.templateFile,
        fields: script.fields || {},
        subject: script.subject,
    }, { onConflict: 'id' });
    if (error) console.error('saveScript:', error.message);
}

async function deleteScript(id) {
    const { error } = await supabase.from('scripts').delete().eq('id', id);
    if (error) console.error('deleteScript:', error.message);
}

async function getTemplate(filename) {
    const { data, error } = await supabase
        .from('templates')
        .select('content')
        .eq('filename', filename)
        .single();
    if (error || !data) return null;
    return data.content;
}

async function saveTemplate(filename, content) {
    const { error } = await supabase.from('templates').upsert(
        { filename, content },
        { onConflict: 'filename' }
    );
    if (error) console.error('saveTemplate:', error.message);
}

// ── SEED DEFAULTS (once, if table empty) ─────────────────────────────────────

async function seedDefaults() {
    const existing = await getScripts();
    if (existing.length > 0) return;

    const defaults = [
        {
            id: 'payment_delay_1st',
            name: '💜 Payment Delay - 1st',
            templateFile: 'payment_delay_1st.js',
            fields: {
                email: 'mohammadasadkhan369@gmail.com',
                solAmount: '0.2206',
                deadline: 'Monday, 9th March 2026 at 14:39',
            },
            subject: 'Payment Received — ${solAmount} SOL Processing In Progress',
        },
        {
            id: 'duplicate_payment',
            name: '🔴 Duplicate Payment',
            templateFile: 'duplicate_payment.js',
            fields: {
                email: 'volker.jelinek@outlook.de',
                solAmount1: '1.76',
                solAmount2: '0.8236',
                deadline: 'Thursday, 5th March 2026 at 14:00',
            },
            subject: '⚠️ Duplicate Transaction Detected — Action Required',
        },
    ];

    for (const s of defaults) await saveScript(s);
    console.log('✅ Defaults seeded.');
}

// ── HTML EXTRACTION ───────────────────────────────────────────────────────────

function extractHtmlFromJs(jsContent) {
    const match = jsContent.match(/const\s+html\s*=\s*`([\s\S]*?)`;/);
    if (match) return match[1].trim();
    const fallback = jsContent.match(/`([\s\S]*<!DOCTYPE[\s\S]*?<\/html>)/i);
    if (fallback) return fallback[1].trim();
    return null;
}

async function getScriptHtml(script) {
    const filename = script.template_file || script.templateFile;
    if (!filename) return null;
    const content = await getTemplate(filename);
    if (!content) return null;
    return filename.endsWith('.js') ? extractHtmlFromJs(content) : content;
}

// ── FIELD DETECTION ───────────────────────────────────────────────────────────

function detectFields(jsContent) {
    const htmlMatch = jsContent.match(/const\s+html\s*=\s*`([\s\S]*?)`;/) ||
        jsContent.match(/html\s*=\s*`([\s\S]*)`/);
    const htmlBody = htmlMatch ? htmlMatch[1] : jsContent;
    const usedVars = [...new Set([...htmlBody.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]))];
    const topConsts = [...jsContent.matchAll(/^const\s+(\w+)\s*=/gm)].map(m => m[1]);
    const skip = new Set(['html', 'totalSol', 'resend', 'result']);
    return [...new Set([...usedVars, ...topConsts])].filter(v => !skip.has(v));
}

// ── RENDER ────────────────────────────────────────────────────────────────────

async function renderTemplate(script) {
    const fields = { ...(script.fields || {}) };
    if (fields.solAmount1 && fields.solAmount2) {
        fields.totalSol = (parseFloat(fields.solAmount1) + parseFloat(fields.solAmount2)).toFixed(4);
    }
    let subject = script.subject || 'Message from SniperToolX';
    let html = (await getScriptHtml(script)) || '';
    for (const [key, val] of Object.entries(fields)) {
        const re = new RegExp(`\\$\\{${key}\\}`, 'g');
        subject = subject.replace(re, val);
        html = html.replace(re, val);
    }
    return { subject, html, email: fields.email };
}

// ── DOWNLOAD FILE FROM TELEGRAM ───────────────────────────────────────────────

function downloadTelegramFile(fileId) {
    return bot.getFile(fileId).then(info => {
        const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`;
        return new Promise((resolve, reject) => {
            https.get(url, res => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve(data));
                res.on('error', reject);
            }).on('error', reject);
        });
    });
}

// ── SESSION ───────────────────────────────────────────────────────────────────

const sessions = {};
function sess(chatId) {
    if (!sessions[chatId]) sessions[chatId] = { state: 'idle', data: {} };
    return sessions[chatId];
}
function resetSess(chatId) { sessions[chatId] = { state: 'idle', data: {} }; }
function isOwner(chatId) { return chatId === OWNER_ID; }

// ── MENUS ─────────────────────────────────────────────────────────────────────

async function sendMainMenu(chatId) {
    resetSess(chatId);
    const scripts = await getScripts();
    const buttons = scripts.map((s, i) => [{ text: s.name, callback_data: `script:${i}` }]);
    bot.sendMessage(chatId, `*⚡ SniperToolX Control Panel*\n\nSelect a script or create a new one:`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                ...buttons,
                [{ text: '➕  New Script', callback_data: 'new_script' }],
            ],
        },
    });
}

async function sendScriptMenu(chatId, idx) {
    const scripts = await getScripts();
    const s = scripts[idx];
    if (!s) return sendMainMenu(chatId);
    const fieldLines = Object.entries(s.fields || {})
        .map(([k, v]) => `• \`${k}\`: ${v}`).join('\n') || '_No fields set_';
    const tpl = s.template_file || s.templateFile || '⚠️ No file uploaded';

    bot.sendMessage(chatId,
        `*${s.name}*\n\n📄 *File:* \`${tpl}\`\n\n*Fields:*\n${fieldLines}\n\n*Subject:* ${s.subject}`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✏️ Edit Fields', callback_data: `edit_fields:${idx}` },
                        { text: '▶️ Run', callback_data: `run:${idx}` },
                    ],
                    [
                        { text: '📤 Upload New JS', callback_data: `upload_js:${idx}` },
                        { text: '📋 Copy JS', callback_data: `copy_js:${idx}` },
                    ],
                    [
                        { text: '✏️ Edit Subject', callback_data: `edit_subject:${idx}` },
                        { text: '🗑️ Delete', callback_data: `delete:${idx}` },
                    ],
                    [{ text: '🔙 Home', callback_data: 'home' }],
                ],
            },
        }
    );
}

async function sendEditFieldsMenu(chatId, idx) {
    const scripts = await getScripts();
    const s = scripts[idx];
    const fieldButtons = Object.entries(s.fields || {}).map(([key, val]) => [{
        text: `✏️ ${key}: ${val}`,
        callback_data: `set_field:${idx}:${key}`,
    }]);
    bot.sendMessage(chatId, `*Edit Fields — ${s.name}*\n\nTap a field to update it:`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                ...fieldButtons,
                [{ text: '🔙 Back', callback_data: `script:${idx}` }],
            ],
        },
    });
}

// ── RUN ───────────────────────────────────────────────────────────────────────

async function runScript(chatId, idx) {
    const scripts = await getScripts();
    const script = scripts[idx];

    const html = await getScriptHtml(script);
    if (!html) {
        return bot.sendMessage(chatId, `❌ No JS template found. Upload one first.`, {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] },
        });
    }

    const email = script.fields?.email;
    if (!email) {
        return bot.sendMessage(chatId, `❌ No \`email\` field set. Edit fields first.`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] },
        });
    }

    await bot.sendMessage(chatId, `⏳ Sending *${script.name}* to \`${email}\`...`, { parse_mode: 'Markdown' });

    try {
        const { subject, html: rendered } = await renderTemplate(script);
        const result = await resend.emails.send({
            from: 'SniperToolX <orders@snipertoolx.com>',
            to: email,
            subject,
            html: rendered,
        });
        bot.sendMessage(chatId,
            `✅ *Sent!*\n\n📨 To: \`${email}\`\n📋 Subject: ${subject}\n🆔 ID: \`${result.data?.id || 'ok'}\``,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] } }
        );
    } catch (err) {
        bot.sendMessage(chatId,
            `❌ *Failed*\n\n\`${err.message}\``,
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] } }
        );
    }
}

// ── FIELD COLLECTION ──────────────────────────────────────────────────────────

async function startFieldCollection(chatId, idx, fieldNames) {
    if (fieldNames.length === 0) {
        bot.sendMessage(chatId, `✅ JS uploaded! No fields detected — script is ready.`);
        return sendScriptMenu(chatId, idx);
    }

    const scripts = await getScripts();
    const script = scripts[idx];
    const existing = script.fields || {};
    const newFields = {};
    for (const key of fieldNames) newFields[key] = existing[key] || '';
    script.fields = newFields;
    await saveScript({ ...script, templateFile: script.template_file || script.templateFile });

    const s = sess(chatId);
    s.state = 'collecting_fields';
    s.data = { idx, fieldNames, fillIndex: 0, fields: newFields };
    askNextField(chatId, s.data);
}

function askNextField(chatId, data) {
    const { fieldNames, fillIndex, fields } = data;
    const key = fieldNames[fillIndex];
    const total = fieldNames.length;
    const current = fields?.[key] || '';
    bot.sendMessage(chatId,
        `📝 Field *${fillIndex + 1}/${total}*: \`${key}\`${current ? `\n\nCurrent: \`${current}\`\nSend \`.\` to keep it.` : ''}\n\nType the value:`,
        { parse_mode: 'Markdown' }
    );
}

// ── CALLBACKS ─────────────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    bot.answerCallbackQuery(query.id);
    if (!isOwner(chatId)) return bot.sendMessage(chatId, '⛔ Unauthorised.');

    const s = sess(chatId);

    if (data === 'home') return sendMainMenu(chatId);
    if (data.startsWith('script:')) return sendScriptMenu(chatId, parseInt(data.split(':')[1]));
    if (data.startsWith('edit_fields:')) return sendEditFieldsMenu(chatId, parseInt(data.split(':')[1]));

    if (data.startsWith('set_field:')) {
        const parts = data.split(':');
        s.state = 'set_field';
        s.data = { idx: parseInt(parts[1]), key: parts[2] };
        return bot.sendMessage(chatId, `✏️ New value for *${parts[2]}*:\n\n/cancel to abort`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('edit_subject:')) {
        const idx = parseInt(data.split(':')[1]);
        const scripts = await getScripts();
        s.state = 'set_subject';
        s.data = { idx };
        return bot.sendMessage(chatId, `Current subject:\n\`${scripts[idx].subject}\`\n\nSend new subject:\n/cancel to abort`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('copy_js:')) {
        const idx = parseInt(data.split(':')[1]);
        const scripts = await getScripts();
        const script = scripts[idx];
        const filename = script.template_file || script.templateFile;
        if (!filename) {
            return bot.sendMessage(chatId, `⚠️ No JS file uploaded yet.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] },
            });
        }
        const content = await getTemplate(filename);
        if (!content) {
            return bot.sendMessage(chatId, `⚠️ JS file not found in database.`, {
                reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] },
            });
        }
        const tmpPath = path.join('/tmp', filename);
        fs.writeFileSync(tmpPath, content);
        await bot.sendDocument(chatId, tmpPath, {
            caption: `📄 *${script.name}* — edit and re-upload via Upload New JS.`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: `script:${idx}` }]] },
        });
        fs.unlinkSync(tmpPath);
        return;
    }

    if (data.startsWith('upload_js:')) {
        const idx = parseInt(data.split(':')[1]);
        s.state = 'awaiting_js_file';
        s.data = { idx };
        return bot.sendMessage(chatId, `📤 *Upload JS File*\n\nSend your \`.js\` file now. I'll save it and ask you to fill in the fields.\n\n/cancel to abort`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('run:')) return runScript(chatId, parseInt(data.split(':')[1]));

    if (data.startsWith('delete:')) {
        const idx = parseInt(data.split(':')[1]);
        const scripts = await getScripts();
        const script = scripts[idx];
        await deleteScript(script.id);
        bot.sendMessage(chatId, `🗑️ *${script.name}* deleted.`, { parse_mode: 'Markdown' });
        return sendMainMenu(chatId);
    }

    if (data === 'new_script') {
        s.state = 'new_name';
        s.data = {};
        return bot.sendMessage(chatId, `➕ *New Script*\n\nWhat's the name?`, { parse_mode: 'Markdown' });
    }
});

// ── MESSAGES ──────────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return bot.sendMessage(chatId, '⛔ Unauthorised.');

    const s = sess(chatId);
    const text = msg.text?.trim();

    if (text) {
        if (text === '/start') return sendMainMenu(chatId);
        if (text === '/cancel') {
            resetSess(chatId);
            bot.sendMessage(chatId, '❌ Cancelled.');
            return sendMainMenu(chatId);
        }

        if (s.state === 'set_field') {
            const { idx, key } = s.data;
            const scripts = await getScripts();
            const script = scripts[idx];
            script.fields = script.fields || {};
            script.fields[key] = text;
            await saveScript({ ...script, templateFile: script.template_file || script.templateFile });
            resetSess(chatId);
            bot.sendMessage(chatId, `✅ *${key}* → \`${text}\``, { parse_mode: 'Markdown' });
            return sendEditFieldsMenu(chatId, idx);
        }

        if (s.state === 'set_subject') {
            const { idx } = s.data;
            const scripts = await getScripts();
            const script = scripts[idx];
            script.subject = text;
            await saveScript({ ...script, templateFile: script.template_file || script.templateFile });
            resetSess(chatId);
            bot.sendMessage(chatId, `✅ Subject updated.`);
            return sendScriptMenu(chatId, idx);
        }

        if (s.state === 'collecting_fields') {
            const { idx, fieldNames, fillIndex } = s.data;
            const key = fieldNames[fillIndex];
            const scripts = await getScripts();
            const script = scripts[idx];

            if (text !== '.') {
                script.fields[key] = text === '-' ? '' : text;
                s.data.fields = script.fields;
                await saveScript({ ...script, templateFile: script.template_file || script.templateFile });
            }

            const nextIndex = fillIndex + 1;
            if (nextIndex < fieldNames.length) {
                s.data.fillIndex = nextIndex;
                return askNextField(chatId, s.data);
            } else {
                resetSess(chatId);
                bot.sendMessage(chatId, `✅ *All fields set! Script is ready.*`, { parse_mode: 'Markdown' });
                return sendScriptMenu(chatId, idx);
            }
        }

        if (s.state === 'new_name') {
            s.data.name = text;
            s.state = 'new_subject';
            return bot.sendMessage(chatId, `Subject line?\n(use \`\${fieldName}\` for dynamic parts)`, { parse_mode: 'Markdown' });
        }

        if (s.state === 'new_subject') {
            const newId = 'custom_' + Date.now();
            const newScript = {
                id: newId,
                name: s.data.name,
                templateFile: `${newId}.js`,
                fields: {},
                subject: text,
            };
            await saveScript(newScript);
            const scripts = await getScripts();
            const idx = scripts.findIndex(sc => sc.id === newId);
            s.state = 'awaiting_js_file';
            s.data = { idx };
            return bot.sendMessage(chatId,
                `✅ *${newScript.name}* created!\n\n📤 Now upload your \`.js\` file and I'll ask you to fill in all the fields.`,
                { parse_mode: 'Markdown' }
            );
        }

        if (s.state === 'awaiting_js_file') {
            return bot.sendMessage(chatId, `📤 Please send a \`.js\` file — not text.\n\n/cancel to abort`);
        }

        return sendMainMenu(chatId);
    }

    if (msg.document) {
        const doc = msg.document;
        const fileName = doc.file_name || '';

        if (s.state !== 'awaiting_js_file') {
            return bot.sendMessage(chatId, `📎 Not expecting a file right now. Use /start to go home.`);
        }
        if (!fileName.endsWith('.js')) {
            return bot.sendMessage(chatId, `⚠️ Please send a \`.js\` file.`);
        }

        await bot.sendMessage(chatId, `⏳ Reading file...`);

        try {
            const jsContent = await downloadTelegramFile(doc.file_id);
            if (!jsContent || jsContent.trim().length === 0) {
                return bot.sendMessage(chatId, `❌ File appears to be empty.`);
            }

            const { idx } = s.data;
            const scripts = await getScripts();
            const script = scripts[idx];
            const templateFileName = script.template_file || script.templateFile || `${script.id}.js`;

            await saveTemplate(templateFileName, jsContent);
            await saveScript({ ...script, templateFile: templateFileName });
            resetSess(chatId);

            const fieldNames = detectFields(jsContent);

            if (fieldNames.length === 0) {
                bot.sendMessage(chatId, `✅ JS saved! No fields detected — script is ready.`);
                return sendScriptMenu(chatId, idx);
            }

            bot.sendMessage(chatId,
                `✅ *JS saved!* Found ${fieldNames.length} field${fieldNames.length > 1 ? 's' : ''}: ${fieldNames.map(f => `\`${f}\``).join(', ')}\n\nLet's fill them in:`,
                { parse_mode: 'Markdown' }
            );
            return startFieldCollection(chatId, idx, fieldNames);

        } catch (err) {
            return bot.sendMessage(chatId, `❌ Failed: \`${err.message}\``, { parse_mode: 'Markdown' });
        }
    }
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running.');
}).listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

seedDefaults().then(() => console.log('🤖 SniperToolX Bot running...'));