# HireMeAI

A chatbot that answers questions about Swarup's CV. FastAPI + Groq backend, plain HTML/CSS/JS frontend.

```
backend/    FastAPI app (main.py), the CV PDF, requirements.txt, .env.example
frontend/   index.html, style.css, app.js, config.js
```

## Run it locally

Backend (terminal 1):

```bash
cd backend
cp .env.example .env          # then put your GROQ_API_KEY in .env
pip install -r requirements.txt
uvicorn main:app --reload     # http://localhost:8000
```

Frontend (terminal 2):

```bash
cd frontend
python -m http.server 5500    # open http://localhost:5500
```

On localhost the page talks to `http://localhost:8000` automatically.

## Update the CV

Replace `backend/swarupBanerjeecv.pdf` (or set `RESUME_FILE` in `.env`) and restart the server. The CV is read once at startup.

## Deploy

**Backend on Render** (Web Service, root directory `backend`):

- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Environment variables: `GROQ_API_KEY`, and `ALLOWED_ORIGINS` set to your frontend URL

**Frontend on Vercel or Netlify** (root directory `frontend`, no build step):

- Set `window.HIREME_API_URL` in `frontend/config.js` to your Render URL, then deploy.

Never commit `.env`. It is already in `.gitignore`.
