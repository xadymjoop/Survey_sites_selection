import psycopg2
from passlib.hash import bcrypt

def init_db():
    print("Connecting to PostgreSQL database 'survey_db'...")
    try:
        conn = psycopg2.connect(
            dbname="survey_db",
            user="postgres",
            password="0000",
            host="localhost",
            port="5432"
        )
        cur = conn.cursor()
        
        # 1. Create tables
        print("Creating tables...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL
            );
        """)
        
        cur.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT
            );
        """)
        
        cur.execute("""
            CREATE TABLE IF NOT EXISTS site_narratives (
                objectid INT PRIMARY KEY,
                narrative TEXT,
                model_used VARCHAR(50)
            );
        """)
        
        # 2. Seed default users
        print("Seeding users...")
        # admin: admin123
        admin_hash = bcrypt.hash("admin123")
        # user: user123
        user_hash = bcrypt.hash("user123")
        
        cur.execute("""
            INSERT INTO users (username, password_hash, role)
            VALUES (%s, %s, %s)
            ON CONFLICT (username) DO UPDATE 
            SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;
        """, ("admin", admin_hash, "admin"))
        
        cur.execute("""
            INSERT INTO users (username, password_hash, role)
            VALUES (%s, %s, %s)
            ON CONFLICT (username) DO UPDATE 
            SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role;
        """, ("user", user_hash, "user"))
        
        # 3. Seed default settings
        print("Seeding settings...")
        default_url = "https://services3.arcgis.com/g35I7H3cawmNpwmT/arcgis/rest/services/survey123_7d08f5aee5704a449e7a65e0c08ce250_results/FeatureServer"
        
        settings_to_seed = {
            "arcgis_url": default_url,
            "arcgis_token": "",
            "gemini_api_key": "",
            "openai_api_key": "",
            "storytelling_mode": "standard"
        }
        
        for k, v in settings_to_seed.items():
            cur.execute("""
                INSERT INTO settings (key, value)
                VALUES (%s, %s)
                ON CONFLICT (key) DO NOTHING;
            """, (k, v))
            
        conn.commit()
        cur.close()
        conn.close()
        print("SUCCESS: Database initialized and seeded successfully!")
        
    except Exception as e:
        print(f"ERROR: Database initialization failed: {e}")

if __name__ == "__main__":
    init_db()
