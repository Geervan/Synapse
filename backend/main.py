from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer, util
import sqlite3
import json
import os
import hashlib
import numpy as np
import re

app = FastAPI()

# Allow extension to communicate with this local API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading Embedding Model...")
model = SentenceTransformer('all-MiniLM-L6-v2')
print("Model loaded successfully.")

DB_FILE = "memory.db"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    # Removed the DROP TABLE command so your history is permanent across restarts!
    c.execute('''
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            session_title TEXT,
            role TEXT,
            content TEXT,
            embedding TEXT,
            content_hash TEXT
        )
    ''')
    conn.commit()
    conn.close()

init_db()

class IngestRequest(BaseModel):
    session_id: str
    session_title: str = "Unknown Chat"
    role: str
    content: str

class RetrieveRequest(BaseModel):
    session_id: str
    prompt: str
    top_k: int = 3
    max_chars: int = 1200

class DeleteRequest(BaseModel):
    session_id: str

@app.post("/ingest")
async def ingest_message(req: IngestRequest):
    if len(req.content.strip()) < 5:
        return {"status": "ignored_too_short"}
    
    # Deduplication: hash the content and skip if identical chunk already exists
    content_hash = hashlib.md5(req.content.strip().encode()).hexdigest()
    
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT id FROM messages WHERE session_id = ? AND content_hash = ?", (req.session_id, content_hash))
    if c.fetchone():
        conn.close()
        return {"status": "duplicate_skipped"}
        
    embedding = model.encode(req.content).tolist()
    c.execute(
        "INSERT INTO messages (session_id, session_title, role, content, embedding, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
        (req.session_id, req.session_title, req.role, req.content, json.dumps(embedding), content_hash)
    )
    conn.commit()
    conn.close()
    return {"status": "success"}

@app.delete("/sessions")
async def delete_session(req: DeleteRequest):
    if req.session_id:
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute("DELETE FROM messages WHERE session_id = ?", (req.session_id,))
        conn.commit()
        conn.close()
    return {"status": "success"}

@app.get("/sessions")
async def get_sessions():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT session_id, session_title FROM messages GROUP BY session_id")
    sessions = [{"id": row[0], "title": row[1]} for row in c.fetchall()]
    conn.close()
    return {"sessions": sessions}

@app.post("/retrieve")
async def retrieve_context(req: RetrieveRequest):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    # Order by ID to ensure chronological flow
    c.execute("SELECT id, content, embedding FROM messages WHERE session_id = ? ORDER BY id ASC", (req.session_id,))
    rows = c.fetchall()
    conn.close()
    
    if not rows:
        return {"context": ""}
        
    messages = []
    embeddings = []
    id_to_msg = {}
    row_ids = []
    
    for row in rows:
        row_id, content, emb_str = row[0], row[1], row[2]
        messages.append(content)
        embeddings.append(json.loads(emb_str))
        id_to_msg[row_id] = content
        row_ids.append(row_id)
        
    # If the prompt is empty, calculate the mathematical "Centroid" of the conversation
    if not req.prompt or req.prompt.strip() == "":
        if not embeddings:
            return {"context": ""}
            
        emb_array = np.array(embeddings, dtype=np.float32)
        centroid = np.mean(emb_array, axis=0)
        prompt_embedding = centroid
    else:
        prompt_embedding = model.encode(req.prompt)
        
    cosine_scores = util.cos_sim(prompt_embedding, embeddings)[0]
    
    # Hybrid scoring: semantic similarity + keyword boost
    prompt_words = set(re.split(r'[\s\-_/]+', req.prompt.lower())) if req.prompt else set()
    prompt_words = {w for w in prompt_words if len(w) > 2}
    results = []
    for i in range(len(cosine_scores)):
        semantic_score = cosine_scores[i].item()
        # Keyword boost: how many prompt words appear in this chunk?
        if prompt_words:
            chunk_lower = messages[i].lower()
            keyword_hits = sum(1 for w in prompt_words if w in chunk_lower)
            keyword_boost = min(keyword_hits * 0.15, 0.5)  # stronger boost
        else:
            keyword_boost = 0
        final_score = semantic_score + keyword_boost
        results.append((final_score, row_ids[i]))
        # Debug: print top keyword matches
        if keyword_boost > 0:
            preview = messages[i][:60].replace('\n', ' ')
            print(f"  [HYBRID] sem={semantic_score:.3f} kw={keyword_boost:.2f} total={final_score:.3f} | {preview}...")
        
    results.sort(reverse=True, key=lambda x: x[0])
    
    # Token-budget retrieval: fill until we hit the character limit
    selected_texts = []
    total_chars = 0
    
    for score, r_id in results:
        if score > 0.15:
            idx = row_ids.index(r_id)
            text = rows[idx][1]
            if text not in selected_texts:
                # Always include at least 1 chunk, then enforce budget
                if len(selected_texts) >= 1 and total_chars + len(text) > req.max_chars:
                    break
                selected_texts.append(text)
                total_chars += len(text)
                
    if not selected_texts:
        return {"context": ""}
            
    context = "\n---\n".join(selected_texts)
    compressed = compress_context(context)
    # Sentence-level relevance filtering using the embedding model
    compressed = filter_sentences(compressed, prompt_embedding)
    return {"context": compressed}

def compress_context(text):
    """Zero-LLM text compressor. Strips filler but preserves code verbatim."""
    # Step 1: Extract and protect code blocks
    code_blocks = []
    def save_code(match):
        code_blocks.append(match.group(0))
        return f"__CODE_BLOCK_{len(code_blocks)-1}__"
    text = re.sub(r'```[\s\S]*?```', save_code, text)
    text = re.sub(r'`[^`]+`', save_code, text)  # inline code too
    
    # Step 2: Compress prose only
    # Strip emojis and special unicode symbols
    text = re.sub(r'[\U0001F300-\U0001FAFF\U00002702-\U000027B0\u2600-\u26FF\u2700-\u27BF]', '', text)
    # Strip markdown formatting but keep content (code already protected)
    text = re.sub(r'[#*_~>]', '', text)
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)  # [link](url) -> link
    # Strip filler phrases
    fillers = [
        r"\bbasically\b", r"\bactually\b", r"\bjust\b", r"\breally\b",
        r"\bsimply\b", r"\bobviously\b", r"\bclearly\b", r"\bessentially\b",
        r"\bI think\b", r"\bI believe\b", r"\bI mean\b",
        r"\byou know\b", r"\blet me know\b", r"\bfeel free\b",
        r"\bif you want\b", r"\bif you need\b",
        r"\bthat being said\b", r"\bhaving said that\b",
        r"\bat the end of the day\b", r"\bin my opinion\b",
        r"\bto be honest\b", r"\bthe thing is\b",
        r"\bkind of\b", r"\bsort of\b",
        r"\bas mentioned\b", r"\bas I said\b", r"\bas we discussed\b",
        r"\bfor example\b", r"\bfor instance\b",
        r"\bin other words\b", r"\bthat means\b",
    ]
    for filler in fillers:
        text = re.sub(filler, '', text, flags=re.IGNORECASE)
    # Strip common articles and low-info words (caveman mode)
    # Strip common articles and truly low-info words only (safe caveman mode)
    stopwords = r'\b(the|a|an|very|quite|rather|furthermore|moreover|additionally|nevertheless|essentially|basically|approximately|specifically|particularly|relatively|apparently|presumably|arguably)\b'
    text = re.sub(stopwords, '', text, flags=re.IGNORECASE)
    # Abbreviate common terms
    abbrevs = {
        r'\bapplication\b': 'app', r'\bdatabase\b': 'DB', r'\bfunction\b': 'fn',
        r'\bconfiguration\b': 'config', r'\benvironment\b': 'env',
        r'\brepository\b': 'repo', r'\bdirectory\b': 'dir',
        r'\bimplementation\b': 'impl', r'\bdocumentation\b': 'docs',
        r'\binformation\b': 'info', r'\bpackage\b': 'pkg',
    }
    for pattern, replacement in abbrevs.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    # Collapse multiple spaces/newlines
    text = re.sub(r' {2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r' \n', '\n', text)
    # Deduplicate identical lines
    lines = text.split('\n')
    seen = set()
    deduped = []
    for line in lines:
        stripped = line.strip()
        if stripped and stripped not in seen:
            seen.add(stripped)
            deduped.append(line)
        elif not stripped:
            deduped.append(line)
    result = '\n'.join(deduped).strip()
    
    # Step 3: Restore protected code blocks
    for i, block in enumerate(code_blocks):
        result = result.replace(f"__CODE_BLOCK_{i}__", block)
    return result

def filter_sentences(text, query_embedding):
    """Keep only sentences that are relevant to the query/centroid."""
    sentences = re.split(r'(?<=[.!?])\s+', text)
    if len(sentences) <= 3:
        return text  # Too short to filter
    
    sent_embeddings = model.encode(sentences)
    scores = util.cos_sim(query_embedding, sent_embeddings)[0]
    
    # Keep sentences scoring in the top 65% of relevance
    sorted_scores = sorted(scores)
    cutoff_idx = max(0, len(sorted_scores) // 3)  # drop bottom third
    threshold = max(float(sorted_scores[cutoff_idx]), 0.1)
    
    kept = []
    for i, sent in enumerate(sentences):
        if scores[i].item() >= threshold:
            kept.append(sent)
    
    return ' '.join(kept) if kept else text

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
