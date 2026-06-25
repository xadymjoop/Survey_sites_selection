from fastapi import FastAPI, Depends, HTTPException, status, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
import psycopg2
from passlib.hash import bcrypt
import jwt
import requests
import datetime
import os
import re

app = FastAPI(title="Survey123 Visualization Platform Backend")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY = "SURVEY_PLATFORM_SECRET_KEY_12345!"
ALGORITHM = "HS256"
security = HTTPBearer()

# Database Helper
def get_db_connection():
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        return psycopg2.connect(db_url)
    return psycopg2.connect(
        dbname="survey_db",
        user="postgres",
        password="0000",
        host="localhost",
        port="5432"
    )

@app.on_event("startup")
def startup_event():
    from db_init import init_db
    init_db()

def get_setting(cur, key, default=""):
    cur.execute("SELECT value FROM settings WHERE key = %s", (key,))
    row = cur.fetchone()
    return row[0] if row else default

def set_setting(cur, key, value):
    cur.execute("""
        INSERT INTO settings (key, value) 
        VALUES (%s, %s)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    """, (key, value))

# Models
class LoginRequest(BaseModel):
    username: str
    password: str

class SettingsUpdate(BaseModel):
    arcgis_url: str
    arcgis_token: str = ""
    gemini_api_key: str = ""
    openai_api_key: str = ""
    storytelling_mode: str = "standard"

class UserCreate(BaseModel):
    username: str
    password: str
    role: str

class UserUpdate(BaseModel):
    username: str = ""
    password: str = ""
    role: str = ""

# Auth Helpers
def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token invalide ou expiré"
        )

def require_admin(payload: dict = Depends(verify_token)):
    if payload.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Accès interdit: rôle Administrateur requis"
        )
    return payload

# Authentification Endpoints
@app.post("/api/auth/login")
def login(data: LoginRequest):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT password_hash, role FROM users WHERE username = %s", (data.username,))
        row = cur.fetchone()
        if not row or not bcrypt.verify(data.password, row[0]):
            raise HTTPException(status_code=400, detail="Nom d'utilisateur ou mot de passe incorrect")
        
        # Generate token
        token_payload = {
            "sub": data.username,
            "role": row[1],
            "exp": datetime.datetime.utcnow() + datetime.timedelta(hours=24)
        }
        token = jwt.encode(token_payload, SECRET_KEY, algorithm=ALGORITHM)
        return {"token": token, "username": data.username, "role": row[1]}
    finally:
        cur.close()
        conn.close()

@app.get("/api/auth/me")
def get_me(payload: dict = Depends(verify_token)):
    return {"username": payload.get("sub"), "role": payload.get("role")}

# Settings Endpoints (Admin only)
@app.get("/api/settings")
def get_settings(payload: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        return {
            "arcgis_url": get_setting(cur, "arcgis_url"),
            "arcgis_token": get_setting(cur, "arcgis_token"),
            "gemini_api_key": get_setting(cur, "gemini_api_key"),
            "openai_api_key": get_setting(cur, "openai_api_key"),
            "storytelling_mode": get_setting(cur, "storytelling_mode", "standard")
        }
    finally:
        cur.close()
        conn.close()

@app.post("/api/settings")
def update_settings(settings: SettingsUpdate, payload: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        set_setting(cur, "arcgis_url", settings.arcgis_url)
        set_setting(cur, "arcgis_token", settings.arcgis_token)
        set_setting(cur, "gemini_api_key", settings.gemini_api_key)
        set_setting(cur, "openai_api_key", settings.openai_api_key)
        set_setting(cur, "storytelling_mode", settings.storytelling_mode)
        conn.commit()
        return {"message": "Configuration mise à jour avec succès"}
    finally:
        cur.close()
        conn.close()

# User Management Endpoints (Admin only)
@app.get("/api/users")
def list_users(payload: dict = Depends(require_admin)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, username, role FROM users ORDER BY id ASC")
        rows = cur.fetchall()
        return [{"id": row[0], "username": row[1], "role": row[2]} for row in rows]
    finally:
        cur.close()
        conn.close()

@app.post("/api/users")
def create_user(user: UserCreate, payload: dict = Depends(require_admin)):
    if not user.username or not user.password or not user.role:
        raise HTTPException(status_code=400, detail="Tous les champs sont requis")
    if user.role not in ["admin", "user"]:
        raise HTTPException(status_code=400, detail="Rôle invalide (doit être 'admin' ou 'user')")
        
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # Check if username exists
        cur.execute("SELECT id FROM users WHERE username = %s", (user.username,))
        if cur.fetchone():
            raise HTTPException(status_code=400, detail="Ce nom d'utilisateur existe déjà")
            
        password_hash = bcrypt.hash(user.password)
        cur.execute("""
            INSERT INTO users (username, password_hash, role)
            VALUES (%s, %s, %s)
        """, (user.username, password_hash, user.role))
        conn.commit()
        return {"message": "Utilisateur créé avec succès"}
    finally:
        cur.close()
        conn.close()

@app.put("/api/users/{user_id}")
def update_user(user_id: int, user: UserUpdate, payload: dict = Depends(require_admin)):
    if user.role and user.role not in ["admin", "user"]:
        raise HTTPException(status_code=400, detail="Rôle invalide (doit être 'admin' ou 'user')")
        
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # Check if user exists
        cur.execute("SELECT username FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Utilisateur non trouvé")
            
        old_username = row[0]
        
        updates = []
        params = []
        
        if user.username and user.username != old_username:
            # Check if new username already exists
            cur.execute("SELECT id FROM users WHERE username = %s", (user.username,))
            if cur.fetchone():
                raise HTTPException(status_code=400, detail="Ce nom d'utilisateur existe déjà")
            updates.append("username = %s")
            params.append(user.username)
            
        if user.password:
            updates.append("password_hash = %s")
            params.append(bcrypt.hash(user.password))
            
        if user.role:
            updates.append("role = %s")
            params.append(user.role)
            
        if not updates:
            return {"message": "Aucune modification apportée"}
            
        params.append(user_id)
        cur.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = %s", tuple(params))
        conn.commit()
        return {"message": "Utilisateur mis à jour avec succès"}
    finally:
        cur.close()
        conn.close()

@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, payload: dict = Depends(require_admin)):
    current_username = payload.get("sub")
    
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # Get user to delete
        cur.execute("SELECT username FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Utilisateur non trouvé")
            
        target_username = row[0]
        if target_username == current_username:
            raise HTTPException(status_code=400, detail="Vous ne pouvez pas supprimer votre propre compte administrateur")
            
        cur.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        return {"message": f"Utilisateur '{target_username}' supprimé avec succès"}
    finally:
        cur.close()
        conn.close()

# ArcGIS Proxy & Processing
@app.get("/api/sites")
def get_sites(payload: dict = Depends(verify_token)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # Load credentials from db
        url = get_setting(cur, "arcgis_url")
        token = get_setting(cur, "arcgis_token")
        
        # Fetch data from ArcGIS Online
        layer_url = url.strip().rstrip("/")
        if layer_url.endswith("FeatureServer"):
            layer_url += "/0"
        elif not layer_url.endswith("/0") and not re.search(r"/FeatureServer/\d+$", layer_url):
            layer_url += "/0"
            
        query_url = f"{layer_url}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json"
        if token:
            query_url += f"&token={token}"
            
        print(f"Server fetching from ArcGIS: {query_url}")
        res = requests.get(query_url, timeout=15)
        if res.status_code != 200:
            raise HTTPException(status_code=500, detail=f"Erreur ArcGIS Server: {res.status_code}")
            
        data = res.json()
        if "error" in data:
            raise HTTPException(status_code=400, detail=f"Erreur ArcGIS REST API: {data['error'].get('message', 'Inconnue')}")
            
        if "features" not in data:
            return []
            
        # Mapped and processed features
        processed_sites = []
        
        # Load all cached narratives
        cur.execute("SELECT objectid, narrative, model_used FROM site_narratives")
        cached = {row[0]: {"narrative": row[1], "model_used": row[2]} for row in cur.fetchall()}
        
        for f in data["features"]:
            attrs = f.get("attributes", {})
            geom = f.get("geometry", {})
            
            # Key mappings helper
            def get_attr(keys):
                for k in keys:
                    if k in attrs:
                        return attrs[k]
                    # Case insensitive check
                    for ak in attrs.keys():
                        if ak.lower() == k.lower():
                            return attrs[ak]
                return None
                
            def clean_oui_non(val):
                if val is None:
                    return "non"
                return "oui" if str(val).strip().lower() == "oui" else "non"
                
            lat = geom.get("y") or geom.get("latitude") or get_attr(['y', 'latitude', 'lat'])
            lng = geom.get("x") or geom.get("longitude") or get_attr(['x', 'longitude', 'lng', 'lon'])
            
            # Fallback coordinates
            if lat is None or lng is None:
                lat, lng = 11.85, -15.5
                
            raw_date = get_attr(['date_mission', 'date'])
            date_str = ""
            if raw_date:
                if isinstance(raw_date, (int, float)):
                    date_str = datetime.datetime.fromtimestamp(raw_date/1000).strftime('%Y-%m-%d')
                else:
                    date_str = str(raw_date).split('T')[0]
                    
            objectid = attrs.get("OBJECTID") or attrs.get("objectid") or get_attr(['objectid', 'id'])
            
            mapped_site = {
                "objectid": objectid,
                "date_mission": date_str,
                "region_admin": get_attr(['region_admin', 'region']) or "Non spécifié",
                "secteur_admin": get_attr(['secteur_admin', 'secteur']) or "Non spécifié",
                "village": get_attr(['village']) or "Non spécifié",
                "nom_site": get_attr(['nom_site', 'nom']) or f"Site {objectid}",
                
                # Criteria
                "crit_1": clean_oui_non(get_attr(['crit_1'])),
                "crit_1_justif": get_attr(['crit_1_justif', 'justif_crit_1']) or "",
                "crit_2": clean_oui_non(get_attr(['crit_2'])),
                "crit_2_justif": get_attr(['crit_2_justif', 'justif_crit_2']) or "",
                "crit_3": clean_oui_non(get_attr(['crit_3'])),
                "crit_3_justif": get_attr(['crit_3_justif', 'justif_crit_3']) or "",
                "crit_4": clean_oui_non(get_attr(['crit_4'])),
                "crit_4_justif": get_attr(['crit_4_justif', 'justif_crit_4']) or "",
                "crit_5": clean_oui_non(get_attr(['crit_5'])),
                "crit_5_justif": get_attr(['crit_5_justif', 'justif_crit_5']) or "",
                "crit_6": clean_oui_non(get_attr(['crit_6'])),
                "crit_6_justif": get_attr(['crit_6_justif', 'justif_crit_6']) or "",
                "crit_7": clean_oui_non(get_attr(['crit_7'])),
                "crit_7_justif": get_attr(['crit_7_justif', 'justif_crit_7']) or "",
                "crit_8": clean_oui_non(get_attr(['crit_8'])),
                "crit_8_justif": get_attr(['crit_8_justif', 'justif_crit_8']) or "",
                "crit_9": clean_oui_non(get_attr(['crit_9'])),
                "crit_9_justif": get_attr(['crit_9_justif', 'justif_crit_9']) or "",
                "crit_10": clean_oui_non(get_attr(['crit_10'])),
                "crit_10_justif": get_attr(['crit_10_justif', 'justif_crit_10']) or "",
                
                # Difficulties
                "diff_technique": int(get_attr(['diff_technique']) or 1),
                "diff_technique_justif": get_attr(['diff_technique_justif']) or "",
                "diff_communaute": int(get_attr(['diff_communaute']) or 1),
                "diff_communaute_justif": get_attr(['diff_communaute_justif']) or "",
                "diff_accessibilite": int(get_attr(['diff_accessibilite']) or 1),
                "diff_accessibilite_justif": get_attr(['diff_accessibilite_justif']) or "",
                "diff_taille": int(get_attr(['diff_taille']) or 1),
                "diff_taille_justif": get_attr(['diff_taille_justif']) or "",
                "diff_physicochimique": int(get_attr(['diff_physicochimique']) or 1),
                "diff_physicochimique_justif": get_attr(['diff_physicochimique_justif']) or "",
                
                "decision_commentaire": get_attr(['decision_commentaire', 'commentaire']) or "",
                "site_selectionne": clean_oui_non(get_attr(['site_selectionne', 'selectionne'])),
                
                "latitude": float(lat),
                "longitude": float(lng)
            }
            
            # Recalculate score final and eligibility
            crits = [
                mapped_site["crit_1"], mapped_site["crit_2"], mapped_site["crit_3"],
                mapped_site["crit_4"], mapped_site["crit_5"], mapped_site["crit_6"],
                mapped_site["crit_7"], mapped_site["crit_8"], mapped_site["crit_9"],
                mapped_site["crit_10"]
            ]
            mapped_site["site_eligible"] = "oui" if all(c == "oui" for c in crits) else "non"
            mapped_site["score_final"] = (
                mapped_site["diff_technique"] + mapped_site["diff_communaute"] +
                mapped_site["diff_accessibilite"] + mapped_site["diff_taille"] +
                mapped_site["diff_physicochimique"]
            )
            
            # Get or build narrative
            site_id = mapped_site["objectid"]
            if site_id in cached:
                mapped_site["narrative"] = cached[site_id]["narrative"]
                mapped_site["narrative_model"] = cached[site_id]["model_used"]
            else:
                # Fallback to local spelling-corrected engine on first fetch
                narrative = local_generate_narrative(mapped_site)
                cur.execute("""
                    INSERT INTO site_narratives (objectid, narrative, model_used)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (objectid) DO NOTHING;
                """, (site_id, narrative, "standard"))
                mapped_site["narrative"] = narrative
                mapped_site["narrative_model"] = "standard"
                
            processed_sites.append(mapped_site)
            
        conn.commit()
        return processed_sites
        
    finally:
        cur.close()
        conn.close()

# AI Narrative Generation (Admin only)
@app.post("/api/sites/{objectid}/regenerate")
def regenerate_site_narrative(objectid: int, payload: dict = Depends(require_admin), body: dict = Body(...)):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # Load settings
        mode = body.get("mode", get_setting(cur, "storytelling_mode", "standard"))
        gemini_key = get_setting(cur, "gemini_api_key")
        openai_key = get_setting(cur, "openai_api_key")
        
        # Load processed sites first to get site details
        # For simplicity, query the site parameters from the database cache or fetch all and filter
        # Since we just proxy it, we fetch the sites list
        sites = get_sites(payload)
        site = next((s for s in sites if s["objectid"] == objectid), None)
        if not site:
            raise HTTPException(status_code=404, detail="Site non trouvé")
            
        story = ""
        if mode == "standard":
            story = local_generate_narrative(site)
        elif mode == "gemini":
            if not gemini_key:
                raise HTTPException(status_code=400, detail="Clé API Gemini manquante côté serveur.")
            story = generate_gemini_story(site, gemini_key)
        elif mode in ["openai-mini", "openai-gpt4"]:
            if not openai_key:
                raise HTTPException(status_code=400, detail="Clé API OpenAI manquante côté serveur.")
            model_name = "gpt-4o" if mode == "openai-gpt4" else "gpt-4o-mini"
            story = generate_openai_story(site, openai_key, model_name)
        else:
            story = local_generate_narrative(site)
            
        # Cache in database
        cur.execute("""
            INSERT INTO site_narratives (objectid, narrative, model_used)
            VALUES (%s, %s, %s)
            ON CONFLICT (objectid) DO UPDATE 
            SET narrative = EXCLUDED.narrative, model_used = EXCLUDED.model_used;
        """, (objectid, story, mode))
        conn.commit()
        
        return {"narrative": story, "model_used": mode}
        
    finally:
        cur.close()
        conn.close()

# Local spelling corrector engine (Python implementation)
def clean_spelling_local(text):
    if not text:
        return ""
    cleaned = text.strip()
    
    dictionary = {
        r"a ét[eé]": "a été",
        r"ont ét[eé]": "ont été",
        r"ét[eé] abandonn[eé]": "été abandonné",
        r"\btecnique\b": "technique",
        r"\btecniques\b": "techniques",
        r"\bsens\b": "sans",
        r"\bSens l'\b": "Sans l'",
        r"\bSens l'intervention\b": "Sans l'intervention",
        r"\btr[o0]s\b": "trop",
        r"\bbeacoub\b": "beaucoup",
        r"\bbeacoud\b": "beaucoup",
        r"\bbeacoud'autres\b": "beaucoup d'autres",
        r"\bbeacoub de\b": "beaucoup de",
        r"\bsuplimentaire\b": "supplémentaire",
        r"\bsuplimentaires\b": "supplémentaires",
        r"\beccessible\b": "accessible",
        r"\banviron\b": "environ",
        r"\bneveau\b": "niveau",
        r"\bcana\b": "canal",
        r"\bdesçandant\b": "descendant",
        r"\bsint\b": "sont",
        r"\bors\b": "hors",
        r"\bclocal\b": "local",
        r"\bconsantement\b": "consentement",
        r"\bconsentiment\b": "consentement",
        r"\baccuille\b": "accueille",
        r"\bsute\b": "site",
        r"\bsutes\b": "sites",
        r"\baloigner\b": "éloigné",
        r"\baloigners\b": "éloignés",
        r"\bhydroligique\b": "hydrologique",
        r"\bhydroligiques\b": "hydrologiques",
        r"\bfacil\b": "facile",
        r"\bfacils\b": "faciles",
        r"\bactivé\b": "activité",
        r"\bactivés\b": "activités",
        r"\bcomlunauté\b": "communauté",
        r"\bcomlunautés\b": "communautés",
        r"\bcreusege\b": "creusement",
        r"\bnecessaire\b": "nécessaire",
        r"\bnecessaires\b": "nécessaires",
        r"\bnecessite\b": "nécessite",
        r"\bencache\b": "encastre",
        r"\briziere\b": "rizière",
        r"\briziere active\b": "rizière active",
        r"\brizières actives\b": "rizières actives",
        r"\bproximit[eé]\b": "proximité",
        r"\bparipherie\b": "périphérie",
        r"\bperipherie\b": "périphérie",
        r"\bcenture\b": "ceinture",
        r"\bcanaux vers le site\b": "canaux vers le site",
        r"\bprés ou coté\b": "près ou à côté",
        r"\bprés\b": "près",
        r"\bcoté\b": "côté",
        r"\bdispinible\b": "disponible",
        r"\bdispinibles\b": "disponibles",
        r"\bdesacorde\b": "désaccord",
        r"\bconffirmée\b": "confirmée",
        r"\bconffirmé\b": "confirmé",
        r"\bleurs conffirmation\b": "leur confirmation",
        r"\bmain d'ouevre\b": "main d'œuvre",
        r"\bmain d'oeuvre\b": "main d'œuvre",
        r"\bmotiver\b": "motivée",
        r"\brapide\b": "rapide",
        r"\brappide\b": "rapide",
        r"\brepartition\b": "répartition",
        r"\bsegregational\b": "ségréguée",
        r"\bencien\b": "ancien",
        r"\benciennes\b": "anciennes",
        r"\bunpeu\b": "un peu",
        r"\btraveaux\b": "travaux"
    }
    
    for pat, rep in dictionary.items():
        cleaned = re.sub(pat, rep, cleaned, flags=re.IGNORECASE)
        
    if len(cleaned) > 0:
        cleaned = cleaned[0].upper() + cleaned[1:]
        if not cleaned.endswith((".", "!", "?")):
            cleaned += "."
            
    return cleaned

def local_generate_narrative(site):
    region = site["region_admin"]
    sector = site["secteur_admin"]
    village = site["village"]
    name = site["nom_site"]
    eligible = site["site_eligible"] == "oui"
    selected = site["site_selectionne"] == "oui"
    score = site["score_final"]
    
    paragraph = f"Le site <b>{name}</b>, situé dans le village de <b>{village}</b> (secteur de {sector}, région de {region}), a été inspecté lors de la mission de terrain. "
    
    crit_text = []
    for k in ["crit_1_justif", "crit_6_justif", "crit_7_justif", "crit_8_justif"]:
        if site.get(k):
            crit_text.append(clean_spelling_local(site[k]))
            
    socio_text = []
    if site.get("crit_2_justif"):
        socio_text.append(f"Localisation : {clean_spelling_local(site['crit_2_justif'])}")
    if site.get("crit_3_justif"):
        socio_text.append(f"Concurrence : {clean_spelling_local(site['crit_3_justif'])}")
    if site.get("crit_5_justif"):
        socio_text.append(f"Historique : {clean_spelling_local(site['crit_5_justif'])}")
    if site.get("crit_9_justif"):
        socio_text.append(f"Engagement social : {clean_spelling_local(site['crit_9_justif'])}")
    if site.get("crit_10_justif"):
        socio_text.append(f"Foncier : {clean_spelling_local(site['crit_10_justif'])}")
        
    if eligible:
        paragraph += "Ce site remplit <b>la totalité des 10 critères d'éligibilité réglementaires</b> du projet de restauration. "
        if crit_text:
            paragraph += f"<br><br><b>Diagnostic écologique du terrain :</b> {' '.join(crit_text)} "
        if socio_text:
            paragraph += f"<br><br><b>Contexte social et foncier :</b> {' '.join(socio_text)} "
    else:
        fails = []
        for i in range(1, 11):
            if site[f"crit_{i}"] != "oui":
                fails.append(f"Critère {i}")
        paragraph += f"L'évaluation a conclu que <b>ce site n'est pas éligible</b> en raison de la non-conformité de certains verrous majeurs : <b>{', '.join(fails)}</b>. "
        
        failed_justifs = []
        for i in range(1, 11):
            if site[f"crit_{i}"] != "oui" and site.get(f"crit_{i}_justif"):
                failed_justifs.append(f"<b>Critère {i}</b> : {clean_spelling_local(site[f'crit_{i}_justif'])}")
        if failed_justifs:
            paragraph += f"<br><br><b>Justification de la non-éligibilité :</b><br>{'<br>'.join(failed_justifs)}"
            
    diff_justifs = []
    if site.get("diff_technique_justif"):
        diff_justifs.append(f"Technique : {clean_spelling_local(site['diff_technique_justif'])}")
    if site.get("diff_communaute_justif"):
        diff_justifs.append(f"Communauté : {clean_spelling_local(site['diff_communaute_justif'])}")
    if site.get("diff_accessibilite_justif"):
        diff_justifs.append(f"Accessibilité : {clean_spelling_local(site['diff_accessibilite_justif'])}")
    if site.get("diff_taille_justif"):
        diff_justifs.append(f"Taille : {clean_spelling_local(site['diff_taille_justif'])}")
    if site.get("diff_physicochimique_justif"):
        diff_justifs.append(f"Physico-chimie : {clean_spelling_local(site['diff_physicochimique_justif'])}")
        
    paragraph += f"<br><br>Concernant la faisabilité technique et l'index de difficulté (évalué à <b>{score}/15</b>) : "
    if diff_justifs:
        paragraph += " ".join(diff_justifs)
    else:
        if score <= 8:
            paragraph += "le site présente une faisabilité optimale (Facile). Les travaux légers requis et l'implication de la communauté facilitent grandement l'intervention."
        elif score <= 11:
            paragraph += "le site présente une difficulté modérée. Les verrous techniques ou d'accessibilité devront être suivis de près lors des travaux."
        else:
            paragraph += "le site présente des contraintes logistiques et écologiques substantielles qui complexifient grandement le reboisement."
            
    if selected:
        paragraph += "<br><br><b>Décision stratégique :</b> Le site est <b>sélectionné pour la restauration active</b>."
    return paragraph


# AI Call APIs Side helpers
def build_ai_prompt_server(site):
    criteria_names = {
        "crit_1": "Anciennes rizières salinisées ou déboisées sans régénération",
        "crit_2": "Situé dans les aires protégées ou zones périphériques des Parcs Nationaux de Cacheu ou Cantanhez",
        "crit_3": "Absence d'autre projet ou initiative de restauration concurrente sur le site",
        "crit_4": "Non classé comme « forêt » sur la carte de référence REDD+ 2011",
        "crit_5": "Abandonné depuis au moins 2 ans, aucune activité agricole en cours ou prévue",
        "crit_6": "Facteurs anthropiques créant une hydrologie défavorable (ex: digues bloquant l'eau)",
        "crit_7": "Mangrove adulte inexistante ou extrêmement clairsemée sur le site",
        "crit_8": "Régénération naturelle de mangrove absente ou très limitée",
        "crit_9": "Consentement Libre, Informé et Préalable (CLIP) signé par la communauté locale",
        "crit_10": "Absence totale de litige sur la propriété foncière ou l'accès au site"
    }
    
    crit_lines = []
    for i in range(1, 11):
        key = f"crit_{i}"
        val = site[key]
        justif = site[f"{key}_justif"]
        status = "CONFORME (Oui)" if val == "oui" else "NON CONFORME (Non)"
        crit_desc = criteria_names[key]
        justif_str = f" | Commentaire terrain : {justif}" if justif else " | Aucun commentaire saisi."
        crit_lines.append(f"- {key.upper()} ({crit_desc}) : {status}{justif_str}")
        
    criteria_details = "\n".join(crit_lines)
    
    diff_lines = []
    diff_names = {
        "diff_technique": "Difficulté Technique (digues, canaux, distance à l'eau)",
        "diff_communaute": "Implication Communautaire (main d'œuvre, adhésion locale)",
        "diff_accessibilite": "Accessibilité Géographique (pistes d'accès, saisons)",
        "diff_taille": "Adéquation de la Taille (taille vs logistique requise)",
        "diff_physicochimique": "Conditions Physico-Chimiques (salinité, sol, semences)"
    }
    
    for key, name in diff_names.items():
        val = site[key]
        justif = site[f"{key}_justif"]
        justif_str = f" | Commentaire : {justif}" if justif else ""
        diff_lines.append(f"- {name} : {val}/3{justif_str}")
        
    diffs_details = "\n".join(diff_lines)
    
    return f"""Fiche de terrain du site de mangrove :
- Nom du site : {site['nom_site']}
- Localisation : Village de {site['village']}, Secteur de {site['secteur_admin']}, Région de {site['region_admin']}
- Date de la mission de terrain : {site['date_mission']}
- Éligibilité réglementaire globale : {'Éligible (Tous les critères sont validés)' if site['site_eligible'] == 'oui' else 'Non Éligible (Certains critères sont rejetés)'}
- Décision de sélection finale : {'Sélectionné pour la restauration active' if site['site_selectionne'] == 'oui' else 'Non sélectionné pour la restauration active'}
- Score global de difficulté : {site['score_final']}/15 (Note de 5 à 15. Plus le score est élevé, plus les contraintes physiques et sociales sont lourdes).

Détail de l'évaluation des 10 critères d'éligibilité :
{criteria_details}

Détail de l'évaluation des index de difficulté (Score de 1 à 3) :
{diffs_details}

Décision finale et commentaires de l'équipe :
- Commentaire décision : {site['decision_commentaire']}
"""

def generate_gemini_story(site, api_key):
    prompt = build_ai_prompt_server(site)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    
    system_instruction = """Tu es l'agent IA de Greenchoice, expert en écologie et en restauration de mangroves en Guinée-Bissau.
Ton objectif est de rédiger un storytelling court, percutant et professionnel en français pour un site de mangrove évalué sur le terrain.
CONSIGNES STRICTES :
1. Reste 100% fidèle aux données fournies. Tu ne dois inventer aucun fait, aucune date, aucun chiffre, ni aucun commentaire écologique ou socio-foncier absent des données sources. Ne mens jamais.
2. Corrige les fautes d'orthographe et de grammaire des commentaires des agents de terrain tout en préservant le sens exact.
3. Rédige un paragraphe de synthèse écologique fluide et percutant en français. Ne mentionne pas de concepts généraux sur les mangroves s'ils n'ont aucun rapport direct avec le site.
"""
    
    res = requests.post(url, json={
        "contents": [{"parts": [{"text": prompt}]}],
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 1000
        }
    }, timeout=15)
    
    if res.status_code != 200:
        raise HTTPException(status_code=500, detail=f"Erreur API Gemini: {res.status_code}")
        
    data = res.json()
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception:
        raise HTTPException(status_code=500, detail="Format de réponse Gemini inattendu.")

def generate_openai_story(site, api_key, model):
    prompt = build_ai_prompt_server(site)
    url = "https://api.openai.com/v1/chat/completions"
    
    system_instruction = """Tu es l'agent IA de Greenchoice, expert en écologie et en restauration de mangroves en Guinée-Bissau.
Ton objectif est de rédiger un storytelling court, percutant et professionnel en français pour un site de mangrove évalué sur le terrain.
CONSIGNES STRICTES :
1. Reste 100% fidèle aux données fournies. Tu ne dois inventer aucun fait, aucune date, aucun chiffre, ni aucun commentaire écologique ou socio-foncier absent des données sources. Ne mens jamais.
2. Corrige les fautes d'orthographe et de grammaire des commentaires des agents de terrain tout en préservant le sens exact.
3. Rédige un paragraphe de synthèse écologique fluide et percutant en français. Ne mentionne pas de concepts généraux sur les mangroves s'ils n'ont aucun rapport direct avec le site.
"""
    
    res = requests.post(url, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }, json={
        "model": model,
        "messages": [
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.1,
        "max_tokens": 1000
    }, timeout=15)
    
    if res.status_code != 200:
        raise HTTPException(status_code=500, detail=f"Erreur API OpenAI: {res.status_code}")
        
    data = res.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception:
        raise HTTPException(status_code=500, detail="Format de réponse OpenAI inattendu.")

# Serve static web app files
app.mount("/", StaticFiles(directory=".", html=True), name="static")


