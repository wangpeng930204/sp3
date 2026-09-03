import os
import secrets
import sqlite3
from pathlib import Path

from flask import Flask, redirect, render_template, request, send_from_directory, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "digital-spd-dev-secret")

DATABASE = Path(__file__).with_name("notes.db")
STEP_DESCRIPTION_MAX_LENGTH = 180


def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def get_shared_workshop_user(conn, workshop_id):
    """Return the common data owner used by every guest in a workshop."""
    email = f"shared-workshop-{workshop_id}@workshop.local"
    existing_user = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if existing_user is not None:
        return existing_user["id"]
    username = f"workshop-shared-{workshop_id}-{secrets.token_hex(4)}"
    conn.execute(
        """
        INSERT OR IGNORE INTO users (username, email, password_hash, role)
        VALUES (?, ?, ?, 'user')
        """,
        (username, email, generate_password_hash(secrets.token_urlsafe(24))),
    )
    return conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()["id"]


def merge_guest_workshop_data(conn, workshop_id, shared_user_id):
    """Move prior per-guest workshop data into the shared collaboration owner."""
    # Step 1 has one value per question. Preserve the most recently updated value.
    response_rows = conn.execute(
        """
        SELECT r.question_id, r.response_text, r.updated_at
        FROM workshop_responses AS r
        JOIN workshop_questions AS q ON q.id = r.question_id
        WHERE q.workshop_id = ? AND r.user_id <> ?
        ORDER BY datetime(r.updated_at), r.rowid
        """,
        (workshop_id, shared_user_id),
    ).fetchall()
    for row in response_rows:
        conn.execute(
            """
            INSERT INTO workshop_responses (user_id, question_id, response_text, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, question_id) DO UPDATE SET
                response_text = excluded.response_text,
                updated_at = excluded.updated_at
            WHERE datetime(excluded.updated_at) >= datetime(workshop_responses.updated_at)
            """,
            (shared_user_id, row["question_id"], row["response_text"], row["updated_at"]),
        )
    conn.execute(
        """
        DELETE FROM workshop_responses
        WHERE user_id <> ?
          AND question_id IN (SELECT id FROM workshop_questions WHERE workshop_id = ?)
        """,
        (shared_user_id, workshop_id),
    )

    # List-style Step 2 answers can all be retained safely.
    conn.execute(
        """
        UPDATE workshop_classified_responses
        SET user_id = ?
        WHERE question_id IN (SELECT id FROM workshop_questions WHERE workshop_id = ?)
        """,
        (shared_user_id, workshop_id),
    )

    # Steps 3-5 share strategy IDs, so move their dependent rows before the strategies.
    strategy_ids = "SELECT id FROM workshop_comparison_responses WHERE workshop_id = ?"
    for table in (
        "workshop_strategy_details",
        "workshop_selected_strategies",
        "workshop_strategy_scale_choices",
        "workshop_strategy_scale_definitions",
    ):
        conn.execute(
            f"UPDATE {table} SET user_id = ? WHERE strategy_response_id IN ({strategy_ids})",
            (shared_user_id, workshop_id),
        )
    conn.execute(
        "UPDATE workshop_comparison_responses SET user_id = ? WHERE workshop_id = ?",
        (shared_user_id, workshop_id),
    )


def generate_unique_access_code(conn):
    for _ in range(100):
        code = f"{secrets.randbelow(9000) + 1000:04d}"
        if not conn.execute("SELECT 1 FROM used_access_codes WHERE code = ?", (code,)).fetchone():
            return code
    for number in range(1000, 10000):
        code = str(number)
        if not conn.execute("SELECT 1 FROM used_access_codes WHERE code = ?", (code,)).fetchone():
            return code
    raise RuntimeError("All four-digit workshop pairing codes have been used.")


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_verified INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO users (username, email, password_hash, role)
            VALUES (?, ?, ?, ?)
            """,
            ("Admin", "admin@example.local", generate_password_hash("admin"), "admin"),
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                access_code TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        workshop_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(workshops)").fetchall()
        }
        if "is_active" not in workshop_columns:
            conn.execute("ALTER TABLE workshops ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0")
            latest_workshop = conn.execute(
                "SELECT id FROM workshops ORDER BY datetime(created_at) DESC, id DESC LIMIT 1"
            ).fetchone()
            if latest_workshop:
                conn.execute("UPDATE workshops SET is_active = 1 WHERE id = ?", (latest_workshop["id"],))
        if "access_code" not in workshop_columns:
            conn.execute("ALTER TABLE workshops ADD COLUMN access_code TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS used_access_codes (
                code TEXT PRIMARY KEY,
                workshop_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO used_access_codes (code, workshop_id)
            SELECT access_code, id FROM workshops WHERE access_code IS NOT NULL
            """
        )
        active_without_code = conn.execute(
            "SELECT id FROM workshops WHERE is_active = 1 AND access_code IS NULL LIMIT 1"
        ).fetchone()
        if active_without_code:
            access_code = generate_unique_access_code(conn)
            conn.execute(
                "UPDATE workshops SET access_code = ? WHERE id = ?",
                (access_code, active_without_code["id"]),
            )
            conn.execute(
                "INSERT INTO used_access_codes (code, workshop_id) VALUES (?, ?)",
                (access_code, active_without_code["id"]),
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lifecycle_stages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_questions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workshop_id INTEGER NOT NULL,
                step_number INTEGER NOT NULL,
                lifecycle_stage_id INTEGER NOT NULL,
                question_text TEXT NOT NULL,
                guidance TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (workshop_id) REFERENCES workshops (id) ON DELETE CASCADE,
                FOREIGN KEY (lifecycle_stage_id) REFERENCES lifecycle_stages (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_step_descriptions (
                workshop_id INTEGER NOT NULL,
                step_number INTEGER NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (workshop_id, step_number),
                FOREIGN KEY (workshop_id) REFERENCES workshops (id) ON DELETE CASCADE
            )
            """
        )
        for step_number in range(1, 6):
            conn.execute(
                """
                INSERT OR IGNORE INTO workshop_step_descriptions (workshop_id, step_number, description)
                SELECT id, ?, '' FROM workshops
                """,
                (step_number,),
            )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_responses (
                user_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                response_text TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, question_id),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (question_id) REFERENCES workshop_questions (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_classified_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                response_text TEXT NOT NULL,
                polarity TEXT NOT NULL CHECK (polarity IN ('advantage', 'disadvantage')),
                category TEXT NOT NULL CHECK (category IN ('social', 'ecological', 'economic')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (question_id) REFERENCES workshop_questions (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_solution_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                question_id INTEGER NOT NULL,
                response_text TEXT NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('social', 'ecological', 'economic')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (question_id) REFERENCES workshop_questions (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_comparison_responses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                workshop_id INTEGER NOT NULL,
                lifecycle_stage_id INTEGER NOT NULL,
                response_text TEXT NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('social', 'ecological', 'economic')),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (workshop_id) REFERENCES workshops (id) ON DELETE CASCADE,
                FOREIGN KEY (lifecycle_stage_id) REFERENCES lifecycle_stages (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_strategy_details (
                user_id INTEGER NOT NULL,
                strategy_response_id INTEGER NOT NULL,
                lsc TEXT NOT NULL DEFAULT '',
                measurement TEXT NOT NULL DEFAULT '',
                comments TEXT NOT NULL DEFAULT '',
                lifecycle_stage_id INTEGER NOT NULL,
                category TEXT NOT NULL CHECK (category IN ('social', 'ecological', 'economic')),
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, strategy_response_id),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (strategy_response_id) REFERENCES workshop_comparison_responses (id) ON DELETE CASCADE,
                FOREIGN KEY (lifecycle_stage_id) REFERENCES lifecycle_stages (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_selected_strategies (
                user_id INTEGER NOT NULL,
                strategy_response_id INTEGER NOT NULL,
                selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, strategy_response_id),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (strategy_response_id) REFERENCES workshop_comparison_responses (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_strategy_scale_choices (
                user_id INTEGER NOT NULL,
                strategy_response_id INTEGER NOT NULL,
                scale_value INTEGER NOT NULL CHECK (scale_value BETWEEN 0 AND 9),
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, strategy_response_id),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (strategy_response_id) REFERENCES workshop_comparison_responses (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_strategy_scale_definitions (
                user_id INTEGER NOT NULL,
                strategy_response_id INTEGER NOT NULL,
                scale_value INTEGER NOT NULL CHECK (scale_value BETWEEN 0 AND 9),
                definition TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, strategy_response_id, scale_value),
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (strategy_response_id) REFERENCES workshop_comparison_responses (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fingerprint_respondents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workshop_id INTEGER NOT NULL,
                display_name TEXT NOT NULL,
                name_key TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (workshop_id, name_key),
                FOREIGN KEY (workshop_id) REFERENCES workshops (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fingerprint_ratings (
                respondent_id INTEGER NOT NULL,
                strategy_response_id INTEGER NOT NULL,
                scale_value INTEGER NOT NULL CHECK (scale_value BETWEEN 0 AND 9),
                confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
                comments TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (respondent_id, strategy_response_id),
                FOREIGN KEY (respondent_id) REFERENCES fingerprint_respondents (id) ON DELETE CASCADE,
                FOREIGN KEY (strategy_response_id) REFERENCES workshop_comparison_responses (id) ON DELETE CASCADE
            )
            """
        )
        fingerprint_rating_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(fingerprint_ratings)").fetchall()
        }
        if "confidence" not in fingerprint_rating_columns:
            conn.execute("ALTER TABLE fingerprint_ratings ADD COLUMN confidence INTEGER NOT NULL DEFAULT 50")
        if "comments" not in fingerprint_rating_columns:
            conn.execute("ALTER TABLE fingerprint_ratings ADD COLUMN comments TEXT NOT NULL DEFAULT ''")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS workshop_products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workshop_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (workshop_id, name),
                FOREIGN KEY (workshop_id) REFERENCES workshops (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS fingerprint_product_ratings (
                respondent_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                strategy_response_id INTEGER NOT NULL,
                scale_value INTEGER NOT NULL CHECK (scale_value BETWEEN 0 AND 9),
                confidence INTEGER NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
                comments TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (respondent_id, product_id, strategy_response_id),
                FOREIGN KEY (respondent_id) REFERENCES fingerprint_respondents (id) ON DELETE CASCADE,
                FOREIGN KEY (product_id) REFERENCES workshop_products (id) ON DELETE CASCADE,
                FOREIGN KEY (strategy_response_id) REFERENCES workshop_comparison_responses (id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO workshop_step_descriptions (workshop_id, step_number, description)
            SELECT workshop_id, 4, 'Develop each Step 3 strategy with LSC, measurement, comments, and classifications.'
            FROM workshop_step_descriptions
            WHERE step_number = 3
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO workshop_step_descriptions (workshop_id, step_number, description)
            SELECT workshop_id, 5, 'Define a 0–9 scale for each selected LSC strategy.'
            FROM workshop_step_descriptions
            WHERE step_number = 4
            """
        )
        default_stages = [
            "Raw Material",
            "Manufacturing",
            "Distribution",
            "Use",
            "Maintenance",
            "End of Life",
        ]
        for index, stage_name in enumerate(default_stages, start=1):
            conn.execute(
                """
                INSERT OR IGNORE INTO lifecycle_stages (name, sort_order)
                VALUES (?, ?)
                """,
                (stage_name, index),
            )

init_db()


@app.route("/")
def home():
    return render_template("join.html")


@app.post("/join")
def join_workshop():
    participant_name = request.form.get("participant_name", "").strip()
    access_code = request.form.get("access_code", "").strip()
    form_data = {"participant_name": participant_name, "access_code": access_code}
    if not participant_name:
        return render_template("join.html", error="Please enter your name.", form_data=form_data)
    if len(access_code) != 4 or not access_code.isdigit():
        return render_template("join.html", error="Enter the four-digit workshop code.", form_data=form_data)

    with get_db() as conn:
        workshop = conn.execute(
            "SELECT id FROM workshops WHERE is_active = 1 AND access_code = ?",
            (access_code,),
        ).fetchone()
        if workshop is None:
            return render_template("join.html", error="The workshop code is not valid.", form_data=form_data)
        shared_user_id = get_shared_workshop_user(conn, workshop["id"])
        merge_guest_workshop_data(conn, workshop["id"], shared_user_id)

    session.clear()
    session["user_id"] = shared_user_id
    session["username"] = participant_name
    session["role"] = "user"
    session["workshop_id"] = workshop["id"]
    session["is_workshop_guest"] = True
    return redirect(url_for("user_workshop"))


@app.route("/fingerprint", methods=["GET", "POST"])
def fingerprint_start():
    form_data = {}
    if request.method == "POST":
        participant_name = request.form.get("participant_name", "").strip()
        access_code = request.form.get("access_code", "").strip()
        form_data = {"participant_name": participant_name, "access_code": access_code}
        if not participant_name:
            return render_template("fingerprint_join.html", error="Please enter your name.", form_data=form_data)
        if len(access_code) != 4 or not access_code.isdigit():
            return render_template("fingerprint_join.html", error="Enter the four-digit workshop code.", form_data=form_data)

        with get_db() as conn:
            workshop = conn.execute(
                "SELECT id FROM workshops WHERE is_active = 1 AND access_code = ?",
                (access_code,),
            ).fetchone()
            if workshop is None:
                return render_template("fingerprint_join.html", error="The workshop code is not valid.", form_data=form_data)
            name_key = " ".join(participant_name.casefold().split())
            conn.execute(
                """
                INSERT INTO fingerprint_respondents (workshop_id, display_name, name_key)
                VALUES (?, ?, ?)
                ON CONFLICT(workshop_id, name_key) DO UPDATE SET
                    display_name = excluded.display_name,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (workshop["id"], participant_name, name_key),
            )
            respondent = conn.execute(
                "SELECT id FROM fingerprint_respondents WHERE workshop_id = ? AND name_key = ?",
                (workshop["id"], name_key),
            ).fetchone()

        session["fingerprint_respondent_id"] = respondent["id"]
        session["fingerprint_workshop_id"] = workshop["id"]
        session["fingerprint_name"] = participant_name
        session.pop("fingerprint_product_id", None)
        return redirect(url_for("fingerprint_select_product"))

    return render_template("fingerprint_join.html", form_data=form_data)


@app.route("/fingerprint/products", methods=["GET", "POST"])
def fingerprint_select_product():
    respondent_id = session.get("fingerprint_respondent_id")
    workshop_id = session.get("fingerprint_workshop_id")
    if respondent_id is None or workshop_id is None:
        return redirect(url_for("fingerprint_start"))
    with get_db() as conn:
        workshop = conn.execute("SELECT id, title FROM workshops WHERE id = ?", (workshop_id,)).fetchone()
        products = conn.execute(
            "SELECT id, name FROM workshop_products WHERE workshop_id = ? ORDER BY name COLLATE NOCASE, id",
            (workshop_id,),
        ).fetchall()
        if request.method == "POST":
            product_id = request.form.get("product_id", type=int)
            product = conn.execute(
                "SELECT id FROM workshop_products WHERE id = ? AND workshop_id = ?",
                (product_id, workshop_id),
            ).fetchone()
            if product is not None:
                session["fingerprint_product_id"] = product["id"]
                return redirect(url_for("fingerprint_evaluate"))
            return render_template("fingerprint_products.html", workshop=workshop, products=products,
                                   error="Select a product to continue.")
    return render_template("fingerprint_products.html", workshop=workshop, products=products)


@app.route("/fingerprint/evaluate", methods=["GET", "POST"])
def fingerprint_evaluate():
    respondent_id = session.get("fingerprint_respondent_id")
    workshop_id = session.get("fingerprint_workshop_id")
    product_id = session.get("fingerprint_product_id")
    if respondent_id is None or workshop_id is None:
        return redirect(url_for("fingerprint_start"))
    if product_id is None:
        return redirect(url_for("fingerprint_select_product"))

    with get_db() as conn:
        respondent = conn.execute(
            """
            SELECT r.id, r.display_name, w.id AS workshop_id, w.title
            FROM fingerprint_respondents AS r
            JOIN workshops AS w ON w.id = r.workshop_id
            WHERE r.id = ? AND r.workshop_id = ?
            """,
            (respondent_id, workshop_id),
        ).fetchone()
        if respondent is None:
            session.pop("fingerprint_respondent_id", None)
            session.pop("fingerprint_workshop_id", None)
            return redirect(url_for("fingerprint_start"))
        product = conn.execute(
            "SELECT id, name FROM workshop_products WHERE id = ? AND workshop_id = ?",
            (product_id, workshop_id),
        ).fetchone()
        if product is None:
            session.pop("fingerprint_product_id", None)
            return redirect(url_for("fingerprint_select_product"))

        strategies = conn.execute(
            """
            SELECT r.id, COALESCE(NULLIF(d.lsc, ''), r.response_text) AS name,
                   r.response_text, COALESCE(d.category, r.category) AS category,
                   s.name AS stage_name, s.sort_order
            FROM workshop_comparison_responses AS r
            LEFT JOIN workshop_strategy_details AS d ON d.strategy_response_id = r.id
            JOIN lifecycle_stages AS s ON s.id = COALESCE(d.lifecycle_stage_id, r.lifecycle_stage_id)
            WHERE r.workshop_id = ?
              AND EXISTS (
                  SELECT 1
                  FROM workshop_strategy_scale_definitions AS scale_definition
                  WHERE scale_definition.strategy_response_id = r.id
              )
            ORDER BY s.sort_order, s.id, r.id
            """,
            (workshop_id,),
        ).fetchall()
        strategy_ids = {row["id"] for row in strategies}

        if request.method == "POST":
            strategy_id = request.form.get("strategy_id", type=int)
            scale_value = request.form.get("scale_value", type=int)
            confidence = request.form.get("confidence", 50, type=int)
            comments = request.form.get("comments", "").strip()[:2000]
            if strategy_id in strategy_ids and scale_value is not None and 0 <= scale_value <= 9:
                confidence = max(0, min(100, confidence if confidence is not None else 50))
                conn.execute(
                    """
                    INSERT INTO fingerprint_product_ratings
                        (respondent_id, product_id, strategy_response_id, scale_value, confidence, comments)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(respondent_id, product_id, strategy_response_id) DO UPDATE SET
                        scale_value = excluded.scale_value,
                        confidence = excluded.confidence,
                        comments = excluded.comments,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                    (respondent_id, product_id, strategy_id, scale_value, confidence, comments),
                )
                ordered_ids = [row["id"] for row in strategies]
                current_index = ordered_ids.index(strategy_id)
                next_id = ordered_ids[current_index + 1] if current_index + 1 < len(ordered_ids) else strategy_id
                return redirect(url_for("fingerprint_evaluate", strategy_id=next_id, saved=1))
            return redirect(url_for("fingerprint_evaluate", error="Select a scale value before saving."))

        definition_rows = conn.execute(
            """
            SELECT d.strategy_response_id, d.scale_value, d.definition
            FROM workshop_strategy_scale_definitions AS d
            JOIN workshop_comparison_responses AS r ON r.id = d.strategy_response_id
            WHERE r.workshop_id = ?
            """,
            (workshop_id,),
        ).fetchall()
        definitions = {}
        for row in definition_rows:
            definitions.setdefault(row["strategy_response_id"], {})[row["scale_value"]] = row["definition"]
        rating_details = {
            row["strategy_response_id"]: row
            for row in conn.execute(
                """
                SELECT strategy_response_id, scale_value, confidence, comments
                FROM fingerprint_product_ratings WHERE respondent_id = ? AND product_id = ?
                """,
                (respondent_id, product_id),
            ).fetchall()
        }

    requested_strategy_id = request.args.get("strategy_id", type=int)
    current_index = next(
        (index for index, strategy in enumerate(strategies) if strategy["id"] == requested_strategy_id),
        0,
    ) if strategies else 0
    current_strategy = strategies[current_index] if strategies else None
    previous_strategy = strategies[current_index - 1] if current_index > 0 else None
    next_strategy = strategies[current_index + 1] if current_index + 1 < len(strategies) else None
    ratings = {strategy_id: row["scale_value"] for strategy_id, row in rating_details.items()}
    completed = len(strategy_ids.intersection(ratings))
    average = round(sum(ratings.values()) / len(ratings), 1) if ratings else None
    return render_template(
        "fingerprint_evaluate.html",
        respondent=respondent,
        product=product,
        strategies=strategies,
        definitions=definitions,
        ratings=ratings,
        rating_details=rating_details,
        completed=completed,
        average=average,
        current_strategy=current_strategy,
        current_index=current_index,
        previous_strategy=previous_strategy,
        next_strategy=next_strategy,
    )


@app.route("/dashboard")
def dashboard_home():
    if session.get("role") == "admin":
        return redirect(url_for("expert_dashboard"))

    if session.get("user_id") is not None:
        return redirect(url_for("user_workshop"))

    return redirect(url_for("login"))


@app.route("/admin", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        identifier = request.form.get("identifier", "").strip()
        password = request.form.get("password", "")

        if not identifier:
            return render_template("index.html", error="Please enter your email or username.", identifier=identifier)

        if not password:
            return render_template("index.html", error="Please enter your password.", identifier=identifier)

        with get_db() as conn:
            user = conn.execute(
                """
                SELECT id, username, email, password_hash, role
                FROM users
                WHERE lower(email) = lower(?) OR lower(username) = lower(?)
                """,
                (identifier, identifier),
            ).fetchone()

        if user is None or not check_password_hash(user["password_hash"], password):
            return render_template("index.html", error="Invalid login details.", identifier=identifier)

        if user["role"] != "admin":
            return render_template(
                "index.html",
                error="This account does not have administrator access.",
                identifier=identifier,
            )

        session["user_id"] = user["id"]
        session["username"] = user["username"]
        session["role"] = user["role"]

        return redirect(url_for("expert_dashboard"))

    return render_template("index.html")


@app.route("/login")
def legacy_login():
    return redirect(url_for("login"))


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        form_data = {"username": username, "email": email}

        if not username:
            return render_template("register.html", error="Please enter your name.", form_data=form_data)

        if not email:
            return render_template("register.html", error="Please enter an email address.", form_data=form_data)

        if not password:
            return render_template("register.html", error="Please enter a password.", form_data=form_data)

        if password != confirm_password:
            return render_template("register.html", error="Passwords do not match.", form_data=form_data)

        try:
            with get_db() as conn:
                conn.execute(
                    """
                    INSERT INTO users (username, email, password_hash, role)
                    VALUES (?, ?, ?, ?)
                    """,
                    (username, email, generate_password_hash(password), "user"),
                )
        except sqlite3.IntegrityError:
            return render_template("register.html", error="This account already exists.", form_data=form_data)

        return redirect(url_for("login"))

    return render_template("register.html")


@app.route("/resources/<path:filename>")
def resources(filename):
    return send_from_directory("resouces", filename)


@app.route("/user-management", methods=["GET", "POST"])
def user_management():
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))

    with get_db() as conn:
        user = conn.execute(
            "SELECT id, username, email, role FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()

    if user is None:
        session.clear()
        return redirect(url_for("login"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")

        if not username:
            return render_template("user_management.html", user=user, error="Please enter your name.")

        if password and password != confirm_password:
            return render_template("user_management.html", user=user, error="Passwords do not match.")

        try:
            with get_db() as conn:
                if password:
                    conn.execute(
                        "UPDATE users SET username = ?, password_hash = ? WHERE id = ?",
                        (username, generate_password_hash(password), user_id),
                    )
                else:
                    conn.execute(
                        "UPDATE users SET username = ? WHERE id = ?",
                        (username, user_id),
                    )
        except sqlite3.IntegrityError:
            return render_template("user_management.html", user=user, error="This name is already in use.")

        session["username"] = username
        with get_db() as conn:
            user = conn.execute(
                "SELECT id, username, email, role FROM users WHERE id = ?",
                (user_id,),
            ).fetchone()

        return render_template("user_management.html", user=user, success="Your profile has been updated.")

    return render_template("user_management.html", user=user)


@app.route("/expert")
def expert_dashboard():
    selected_id = request.args.get("workshop_id", type=int)
    active_tab = "settings"

    with get_db() as conn:
        workshops = conn.execute(
            """
            SELECT id, title, is_active, access_code, created_at
            FROM workshops
            ORDER BY datetime(created_at) DESC, id DESC
            LIMIT 10
            """
        ).fetchall()

        selected_workshop = None
        if selected_id is not None:
            selected_workshop = conn.execute(
                "SELECT id, title, access_code, is_active, created_at, updated_at FROM workshops WHERE id = ?",
                (selected_id,),
            ).fetchone()

        if selected_workshop is None and workshops:
            selected_workshop = conn.execute(
                "SELECT id, title, access_code, is_active, created_at, updated_at FROM workshops WHERE id = ?",
                (workshops[0]["id"],),
            ).fetchone()

        lifecycle_stages = conn.execute(
            """
            SELECT id, name, sort_order
            FROM lifecycle_stages
            ORDER BY sort_order, id
            """
        ).fetchall()

        questions_by_stage = {}
        all_questions_by_step_stage = {}
        step_descriptions = {}
        steps = []
        products = []
        if selected_workshop is not None:
            products = conn.execute(
                "SELECT id, name FROM workshop_products WHERE workshop_id = ? ORDER BY name COLLATE NOCASE, id",
                (selected_workshop["id"],),
            ).fetchall()
            description_rows = conn.execute(
                """
                SELECT step_number, description
                FROM workshop_step_descriptions
                WHERE workshop_id = ?
                ORDER BY step_number
                """,
                (selected_workshop["id"],),
            ).fetchall()
            steps = list(description_rows)
            step_descriptions = {row["step_number"]: row["description"] for row in description_rows}
            all_questions = conn.execute(
                """
                SELECT id, step_number, lifecycle_stage_id, question_text, guidance
                FROM workshop_questions
                WHERE workshop_id = ? AND step_number NOT IN (3, 4, 5)
                ORDER BY step_number, datetime(created_at), id
                """,
                (selected_workshop["id"],),
            ).fetchall()
            for question in all_questions:
                all_questions_by_step_stage.setdefault(question["step_number"], {})
                all_questions_by_step_stage[question["step_number"]].setdefault(question["lifecycle_stage_id"], []).append(question)

        valid_tabs = {"settings"} | {f"step{step['step_number']}" for step in steps}
        if active_tab not in valid_tabs:
            active_tab = "settings"

        if selected_workshop is not None and active_tab.startswith("step"):
            step_number = int(active_tab.replace("step", ""))
            questions = [] if step_number in {3, 4, 5} else conn.execute(
                """
                SELECT id, lifecycle_stage_id, question_text, guidance
                FROM workshop_questions
                WHERE workshop_id = ? AND step_number = ?
                ORDER BY datetime(created_at), id
                """,
                (selected_workshop["id"], step_number),
            ).fetchall()
            for question in questions:
                questions_by_stage.setdefault(question["lifecycle_stage_id"], []).append(question)

    return render_template(
        "expert.html",
        workshops=workshops,
        selected_workshop=selected_workshop,
        lifecycle_stages=lifecycle_stages,
        questions_by_stage=questions_by_stage,
        all_questions_by_step_stage=all_questions_by_step_stage,
        active_tab=active_tab,
        steps=steps,
        step_descriptions=step_descriptions,
        products=products,
    )


@app.post("/expert/workshops/new")
def new_workshop():
    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) FROM workshops").fetchone()[0] + 1
        cursor = conn.execute(
            "INSERT INTO workshops (title) VALUES (?)",
            (f"New Workshop {count}",),
        )
        workshop_id = cursor.lastrowid
        conn.executemany(
            "INSERT INTO workshop_step_descriptions (workshop_id, step_number, description) VALUES (?, ?, '')",
            [(workshop_id, step_number) for step_number in range(1, 6)],
        )
    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/workshops/<int:workshop_id>/products")
def add_workshop_product(workshop_id):
    product_name = request.form.get("product_name", "").strip()[:120]
    if product_name:
        try:
            with get_db() as conn:
                conn.execute(
                    "INSERT INTO workshop_products (workshop_id, name) VALUES (?, ?)",
                    (workshop_id, product_name),
                )
        except sqlite3.IntegrityError:
            pass
    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/workshops/<int:workshop_id>/products/<int:product_id>/delete")
def delete_workshop_product(workshop_id, product_id):
    with get_db() as conn:
        conn.execute("DELETE FROM workshop_products WHERE id = ? AND workshop_id = ?", (product_id, workshop_id))
    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/workshops/<int:workshop_id>/steps/new")
def add_workshop_step(workshop_id):
    description = request.form.get("description", "").strip()
    with get_db() as conn:
        step_number = conn.execute(
            "SELECT COALESCE(MAX(step_number), 0) + 1 FROM workshop_step_descriptions WHERE workshop_id = ?",
            (workshop_id,),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO workshop_step_descriptions (workshop_id, step_number, description) VALUES (?, ?, ?)",
            (workshop_id, step_number, description),
        )

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/workshops/<int:workshop_id>/rename")
def rename_workshop(workshop_id):
    title = request.form.get("title", "").strip()
    if title:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE workshops
                SET title = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (title, workshop_id),
            )

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab=request.form.get("tab", "settings")))


@app.post("/expert/workshops/<int:workshop_id>/delete")
def delete_workshop(workshop_id):
    with get_db() as conn:
        conn.execute("DELETE FROM workshops WHERE id = ?", (workshop_id,))

    return redirect(url_for("expert_dashboard"))


@app.post("/expert/workshops/<int:workshop_id>/publish")
def publish_workshop(workshop_id):
    with get_db() as conn:
        workshop = conn.execute(
            "SELECT is_active FROM workshops WHERE id = ?", (workshop_id,)
        ).fetchone()
        if workshop:
            if workshop["is_active"]:
                conn.execute(
                    "UPDATE workshops SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (workshop_id,),
                )
            else:
                conn.execute("UPDATE workshops SET is_active = 0 WHERE is_active = 1")
                access_code_row = conn.execute(
                    "SELECT access_code FROM workshops WHERE id = ?", (workshop_id,)
                ).fetchone()
                access_code = access_code_row["access_code"] or generate_unique_access_code(conn)
                conn.execute(
                    "UPDATE workshops SET is_active = 1, access_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (access_code, workshop_id),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO used_access_codes (code, workshop_id) VALUES (?, ?)",
                    (access_code, workshop_id),
                )
    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab=request.form.get("tab", "settings")))


@app.post("/expert/lifecycle-stages/new")
def add_lifecycle_stage():
    name = request.form.get("name", "").strip()
    workshop_id = request.form.get("workshop_id", type=int)
    if name:
        try:
            with get_db() as conn:
                next_order = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM lifecycle_stages"
                ).fetchone()[0]
                conn.execute(
                    "INSERT INTO lifecycle_stages (name, sort_order) VALUES (?, ?)",
                    (name, next_order),
                )
        except sqlite3.IntegrityError:
            pass

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/lifecycle-stages/<int:stage_id>/rename")
def rename_lifecycle_stage(stage_id):
    name = request.form.get("name", "").strip()
    workshop_id = request.form.get("workshop_id", type=int)
    if name:
        try:
            with get_db() as conn:
                conn.execute("UPDATE lifecycle_stages SET name = ? WHERE id = ?", (name, stage_id))
        except sqlite3.IntegrityError:
            pass

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/lifecycle-stages/<int:stage_id>/delete")
def delete_lifecycle_stage(stage_id):
    workshop_id = request.form.get("workshop_id", type=int)
    with get_db() as conn:
        conn.execute("DELETE FROM lifecycle_stages WHERE id = ?", (stage_id,))

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.post("/expert/lifecycle-stages/reorder")
def reorder_lifecycle_stages():
    stage_ids = request.get_json(silent=True) or {}
    stage_ids = stage_ids.get("stage_ids", [])
    if not isinstance(stage_ids, list) or not all(isinstance(stage_id, int) for stage_id in stage_ids):
        return {"error": "Invalid lifecycle stage order."}, 400

    with get_db() as conn:
        existing_ids = {
            row["id"] for row in conn.execute("SELECT id FROM lifecycle_stages").fetchall()
        }
        if set(stage_ids) != existing_ids or len(stage_ids) != len(existing_ids):
            return {"error": "Lifecycle stages changed. Refresh and try again."}, 409
        conn.executemany(
            "UPDATE lifecycle_stages SET sort_order = ? WHERE id = ?",
            [(position, stage_id) for position, stage_id in enumerate(stage_ids, start=1)],
        )

    return {"ok": True}


@app.post("/expert/workshops/<int:workshop_id>/lifecycle-stages/save")
def save_lifecycle_stages(workshop_id):
    submitted_ids = request.form.getlist("stage_id")
    submitted_names = request.form.getlist("stage_name")
    if len(submitted_ids) != len(submitted_names):
        return redirect(url_for("expert_dashboard", workshop_id=workshop_id))

    submitted = []
    for raw_id, raw_name in zip(submitted_ids, submitted_names):
        name = raw_name.strip()
        if not name:
            continue
        submitted.append((int(raw_id) if raw_id.isdigit() else None, name))
    if len({name for _, name in submitted}) != len(submitted):
        return redirect(url_for("expert_dashboard", workshop_id=workshop_id))

    with get_db() as conn:
        existing_rows = conn.execute(
            "SELECT id, name FROM lifecycle_stages ORDER BY sort_order, id"
        ).fetchall()
        existing_ids = {row["id"] for row in existing_rows}
        kept_ids = {stage_id for stage_id, _ in submitted if stage_id in existing_ids}

        # Temporary names avoid unique-name conflicts when managers reorder or swap names.
        for row in existing_rows:
            conn.execute(
                "UPDATE lifecycle_stages SET name = ? WHERE id = ?",
                (f"__stage_{row['id']}__", row["id"]),
            )

        saved_stages = []
        for position, (stage_id, name) in enumerate(submitted, start=1):
            if stage_id in existing_ids:
                conn.execute(
                    "UPDATE lifecycle_stages SET name = ?, sort_order = ? WHERE id = ?",
                    (name, position, stage_id),
                )
                saved_stages.append((stage_id, name))
            else:
                cursor = conn.execute(
                    "INSERT INTO lifecycle_stages (name, sort_order) VALUES (?, ?)",
                    (name, position),
                )
                saved_stages.append((cursor.lastrowid, name))

        for stage_id in existing_ids - kept_ids:
            conn.execute("DELETE FROM lifecycle_stages WHERE id = ?", (stage_id,))

        for step_number in (1, 2):
            for stage_id, stage_name in saved_stages:
                existing_question = conn.execute(
                    """
                    SELECT id FROM workshop_questions
                    WHERE workshop_id = ? AND step_number = ? AND lifecycle_stage_id = ?
                    LIMIT 1
                    """,
                    (workshop_id, step_number, stage_id),
                ).fetchone()
                if existing_question is None:
                    conn.execute(
                        """
                        INSERT INTO workshop_questions
                            (workshop_id, step_number, lifecycle_stage_id, question_text, guidance)
                        VALUES (?, ?, ?, ?, '')
                        """,
                        (workshop_id, step_number, stage_id, ""),
                    )

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id))


@app.post("/expert/workshops/<int:workshop_id>/questions/new")
def add_question(workshop_id):
    active_tab = request.form.get("tab", "step1")
    try:
        step_number = int(active_tab.removeprefix("step"))
    except ValueError:
        return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))
    if step_number in {3, 4, 5}:
        return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab=f"step{step_number}"))
    stage_id = request.form.get("stage_id", type=int)
    question_text = request.form.get("question_text", "").strip()
    guidance = request.form.get("guidance", "").strip()

    if stage_id is not None:
        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO workshop_questions (workshop_id, step_number, lifecycle_stage_id, question_text, guidance)
                VALUES (?, ?, ?, ? ,?)
                """,
                (workshop_id, step_number, stage_id, question_text, guidance),
            )

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab=active_tab))


@app.post("/expert/workshops/<int:workshop_id>/questions/new-async")
def add_question_async(workshop_id):
    payload = request.get_json(silent=True) or {}
    step_number = payload.get("step_number")
    stage_id = payload.get("stage_id")
    if not isinstance(step_number, int) or step_number not in (1, 2) or not isinstance(stage_id, int):
        return {"error": "Invalid question location."}, 400

    with get_db() as conn:
        stage = conn.execute(
            "SELECT name FROM lifecycle_stages WHERE id = ?", (stage_id,)
        ).fetchone()
        workshop = conn.execute("SELECT 1 FROM workshops WHERE id = ?", (workshop_id,)).fetchone()
        if stage is None or workshop is None:
            return {"error": "Workshop or lifecycle stage not found."}, 404
        cursor = conn.execute(
            """
            INSERT INTO workshop_questions
                (workshop_id, step_number, lifecycle_stage_id, question_text, guidance)
            VALUES (?, ?, ?, '', '')
            """,
            (workshop_id, step_number, stage_id),
        )
        question_id = cursor.lastrowid

    return {
        "id": question_id,
        "stage_name": stage["name"],
        "autosave_url": url_for("autosave_question", question_id=question_id),
        "delete_url": url_for("delete_question", question_id=question_id),
    }


@app.post("/expert/questions/<int:question_id>/update")
def update_question(question_id):
    active_tab = request.form.get("tab", "step1")
    workshop_id = request.form.get("workshop_id", type=int)
    stage_id = request.form.get("stage_id", type=int)
    question_text = request.form.get("question_text", "").strip()
    guidance = request.form.get("guidance", "").strip()

    if workshop_id is not None and stage_id is not None and question_text:
        with get_db() as conn:
            conn.execute(
                """
                UPDATE workshop_questions
                SET lifecycle_stage_id = ?, question_text = ?, guidance = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND workshop_id = ?
                """,
                (stage_id, question_text, guidance, question_id, workshop_id),
            )

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab=active_tab))


@app.post("/expert/questions/<int:question_id>/autosave")
def autosave_question(question_id):
    payload = request.get_json(silent=True) or {}
    question_text = str(payload.get("question_text", "")).strip()
    guidance = str(payload.get("guidance", "")).strip()
    with get_db() as conn:
        result = conn.execute(
            """
            UPDATE workshop_questions
            SET question_text = ?, guidance = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (question_text, guidance, question_id),
        )
    if not result.rowcount:
        return {"error": "Question not found."}, 404
    return {"ok": True}


@app.post("/expert/questions/<int:question_id>/delete")
def delete_question(question_id):
    active_tab = request.form.get("tab", "step1")
    workshop_id = request.form.get("workshop_id", type=int)
    with get_db() as conn:
        question = conn.execute(
            "SELECT workshop_id, step_number, lifecycle_stage_id FROM workshop_questions WHERE id = ?",
            (question_id,),
        ).fetchone()
        if question:
            stage_question_count = conn.execute(
                """
                SELECT COUNT(*) FROM workshop_questions
                WHERE workshop_id = ? AND step_number = ? AND lifecycle_stage_id = ?
                """,
                (question["workshop_id"], question["step_number"], question["lifecycle_stage_id"]),
            ).fetchone()[0]
            if stage_question_count > 1:
                conn.execute("DELETE FROM workshop_questions WHERE id = ?", (question_id,))

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab=active_tab))


@app.post("/expert/workshops/<int:workshop_id>/steps/<int:step_number>/description")
def update_step_description(workshop_id, step_number):
    description = request.form.get("description", "").strip()[:STEP_DESCRIPTION_MAX_LENGTH]
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO workshop_step_descriptions (workshop_id, step_number, description)
            VALUES (?, ?, ?)
            ON CONFLICT(workshop_id, step_number) DO UPDATE SET
                description = excluded.description,
                updated_at = CURRENT_TIMESTAMP
            """,
            (workshop_id, step_number, description),
        )

    return redirect(url_for("expert_dashboard", workshop_id=workshop_id, tab="settings"))


@app.route("/user")
def user_workshop():
    with get_db() as conn:
        session_workshop_id = session.get("workshop_id")
        workshop = None
        if session_workshop_id is not None:
            workshop = conn.execute(
                "SELECT id, title FROM workshops WHERE id = ? AND is_active = 1",
                (session_workshop_id,),
            ).fetchone()
        if workshop is None:
            workshop = conn.execute(
                """
                SELECT id, title
                FROM workshops
                WHERE is_active = 1
                ORDER BY datetime(updated_at) DESC, id DESC
                LIMIT 1
                """
            ).fetchone()
        if workshop is not None and session.get("role") == "user":
            shared_user_id = get_shared_workshop_user(conn, workshop["id"])
            merge_guest_workshop_data(conn, workshop["id"], shared_user_id)
            session["user_id"] = shared_user_id
            session["workshop_id"] = workshop["id"]
            session["is_workshop_guest"] = True
        steps = []
        if workshop is not None:
            steps = conn.execute(
                """
                SELECT step_number, description
                FROM workshop_step_descriptions
                WHERE workshop_id = ?
                ORDER BY step_number
                """,
                (workshop["id"],),
            ).fetchall()

    return render_template("user.html", workshop=workshop, steps=steps)


@app.route("/user-step")
def user_step():
    requested_workshop_id = request.args.get("workshop_id", type=int)
    requested_step = request.args.get("step", 1, type=int)
    requested_stage_id = request.args.get("stage_id", type=int)
    requested_question_id = request.args.get("question_id", type=int)

    with get_db() as conn:
        if requested_workshop_id is not None:
            workshop = conn.execute(
                "SELECT id, title FROM workshops WHERE id = ? AND is_active = 1",
                (requested_workshop_id,),
            ).fetchone()
        else:
            workshop = conn.execute(
                """
                SELECT id, title
                FROM workshops
                WHERE is_active = 1
                ORDER BY datetime(updated_at) DESC, id DESC
                LIMIT 1
                """
            ).fetchone()
        if workshop is None:
            workshop = conn.execute(
                """
                SELECT id, title
                FROM workshops
                WHERE is_active = 1
                ORDER BY datetime(updated_at) DESC, id DESC
                LIMIT 1
                """
            ).fetchone()

        if workshop is not None and session.get("role") == "user":
            shared_user_id = get_shared_workshop_user(conn, workshop["id"])
            merge_guest_workshop_data(conn, workshop["id"], shared_user_id)
            session["user_id"] = shared_user_id
            session["workshop_id"] = workshop["id"]
            session["is_workshop_guest"] = True

        step_rows = []
        if workshop is not None:
            step_rows = conn.execute(
                "SELECT step_number, description FROM workshop_step_descriptions WHERE workshop_id = ? ORDER BY step_number",
                (workshop["id"],),
            ).fetchall()
        step_numbers = [row["step_number"] for row in step_rows]
        current_step = requested_step if requested_step in step_numbers else (step_numbers[0] if step_numbers else 1)

        lifecycle_stages = conn.execute(
            "SELECT id, name, sort_order FROM lifecycle_stages ORDER BY sort_order, id"
        ).fetchall()

        questions = []
        saved_responses = {}
        classified_responses = {}
        solution_responses = {}
        strategy_details = {}
        selected_strategy_ids = set()
        strategy_scale_choices = {}
        strategy_scale_definitions = {}
        completed_step_numbers = set()
        paired_questions = {1: {}, 2: {}}
        paired_question_lists = {1: {}, 2: {}}
        user_id = session.get("user_id")
        if workshop is not None:
            if user_id is not None:
                selected_strategy_ids = {
                    row["strategy_response_id"]
                    for row in conn.execute(
                        """
                        SELECT ss.strategy_response_id
                        FROM workshop_selected_strategies AS ss
                        JOIN workshop_comparison_responses AS r ON r.id = ss.strategy_response_id
                        WHERE ss.user_id = ? AND r.workshop_id = ?
                        """,
                        (user_id, workshop["id"]),
                    ).fetchall()
                }
            if current_step == 3:
                questions = [
                    {
                        "id": stage["id"],
                        "step_number": 3,
                        "lifecycle_stage_id": stage["id"],
                        "question_text": "",
                        "guidance": "",
                        "stage_name": stage["name"],
                        "stage_sort_order": stage["sort_order"],
                    }
                    for stage in lifecycle_stages
                ]
            elif current_step == 4 and user_id is not None:
                strategy_rows = conn.execute(
                    """
                    SELECT r.id, r.lifecycle_stage_id, r.response_text, r.category,
                           s.name AS stage_name, s.sort_order AS stage_sort_order
                    FROM workshop_comparison_responses AS r
                    JOIN lifecycle_stages AS s ON s.id = r.lifecycle_stage_id
                    WHERE r.user_id = ? AND r.workshop_id = ?
                    ORDER BY s.sort_order, s.id, datetime(r.created_at), r.id
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                questions = [
                    {
                        "id": row["id"],
                        "step_number": 4,
                        "lifecycle_stage_id": row["lifecycle_stage_id"],
                        "question_text": row["response_text"],
                        "guidance": "",
                        "stage_name": row["stage_name"],
                        "stage_sort_order": row["stage_sort_order"],
                        "category": row["category"],
                    }
                    for row in strategy_rows
                ]
            elif current_step == 5 and user_id is not None:
                scale_strategy_rows = conn.execute(
                    """
                    SELECT r.id, COALESCE(d.lifecycle_stage_id, r.lifecycle_stage_id) AS lifecycle_stage_id,
                           r.response_text, r.category, d.lsc,
                           s.name AS stage_name, s.sort_order AS stage_sort_order
                    FROM workshop_selected_strategies AS ss
                    JOIN workshop_comparison_responses AS r ON r.id = ss.strategy_response_id
                    LEFT JOIN workshop_strategy_details AS d
                           ON d.strategy_response_id = r.id AND d.user_id = ss.user_id
                    JOIN lifecycle_stages AS s
                         ON s.id = COALESCE(d.lifecycle_stage_id, r.lifecycle_stage_id)
                    WHERE ss.user_id = ? AND r.workshop_id = ?
                    ORDER BY s.sort_order, s.id, datetime(ss.selected_at), r.id
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                questions = [
                    {
                        "id": row["id"],
                        "step_number": 5,
                        "lifecycle_stage_id": row["lifecycle_stage_id"],
                        "question_text": row["lsc"] or row["response_text"],
                        "guidance": row["response_text"],
                        "stage_name": row["stage_name"],
                        "stage_sort_order": row["stage_sort_order"],
                        "category": row["category"],
                    }
                    for row in scale_strategy_rows
                ]
            else:
                questions = conn.execute(
                    """
                    SELECT q.id, q.step_number, q.lifecycle_stage_id,
                           q.question_text, q.guidance, s.name AS stage_name,
                           s.sort_order AS stage_sort_order
                    FROM workshop_questions AS q
                    JOIN lifecycle_stages AS s ON s.id = q.lifecycle_stage_id
                    WHERE q.workshop_id = ? AND q.step_number = ?
                    ORDER BY q.step_number, s.sort_order, s.id,
                             datetime(q.created_at), q.id
                    """,
                    (workshop["id"], current_step),
                ).fetchall()
            if user_id is not None:
                response_rows = conn.execute(
                    """
                    SELECT r.question_id, r.response_text, q.step_number
                    FROM workshop_responses AS r
                    JOIN workshop_questions AS q ON q.id = r.question_id
                    WHERE r.user_id = ? AND q.workshop_id = ?
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                saved_responses = {
                    row["question_id"]: row["response_text"] for row in response_rows
                }
                completed_step_numbers.update(
                    row["step_number"] for row in response_rows if row["response_text"].strip()
                )
                classified_rows = conn.execute(
                    """
                    SELECT r.id, r.question_id, r.response_text, r.polarity, r.category
                    FROM workshop_classified_responses AS r
                    JOIN workshop_questions AS q ON q.id = r.question_id
                    WHERE r.user_id = ? AND q.workshop_id = ? AND q.step_number = 2
                    ORDER BY datetime(r.created_at), r.id
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                for row in classified_rows:
                    classified_responses.setdefault(row["question_id"], []).append(row)
                if classified_rows:
                    completed_step_numbers.add(2)

                solution_rows = conn.execute(
                    """
                    SELECT r.id, r.lifecycle_stage_id, r.response_text, r.category
                    FROM workshop_comparison_responses AS r
                    WHERE r.user_id = ? AND r.workshop_id = ?
                    ORDER BY datetime(r.created_at), r.id
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                for row in solution_rows:
                    solution_responses.setdefault(row["lifecycle_stage_id"], []).append(row)
                if solution_rows:
                    completed_step_numbers.add(3)

                detail_rows = conn.execute(
                    """
                    SELECT d.strategy_response_id, d.lsc, d.measurement, d.comments,
                           d.lifecycle_stage_id, d.category
                    FROM workshop_strategy_details AS d
                    JOIN workshop_comparison_responses AS r ON r.id = d.strategy_response_id
                    WHERE d.user_id = ? AND r.workshop_id = ?
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                strategy_details = {row["strategy_response_id"]: row for row in detail_rows}
                if detail_rows:
                    completed_step_numbers.add(4)

                choice_rows = conn.execute(
                    """
                    SELECT c.strategy_response_id, c.scale_value
                    FROM workshop_strategy_scale_choices AS c
                    JOIN workshop_comparison_responses AS r ON r.id = c.strategy_response_id
                    WHERE c.user_id = ? AND r.workshop_id = ?
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                strategy_scale_choices = {row["strategy_response_id"]: row["scale_value"] for row in choice_rows}
                if choice_rows:
                    completed_step_numbers.add(5)
                definition_rows = conn.execute(
                    """
                    SELECT d.strategy_response_id, d.scale_value, d.definition
                    FROM workshop_strategy_scale_definitions AS d
                    JOIN workshop_comparison_responses AS r ON r.id = d.strategy_response_id
                    WHERE d.user_id = ? AND r.workshop_id = ?
                    """,
                    (user_id, workshop["id"]),
                ).fetchall()
                for row in definition_rows:
                    strategy_scale_definitions.setdefault(row["strategy_response_id"], {})[row["scale_value"]] = row["definition"]

            if current_step == 3:
                paired_rows = conn.execute(
                    """
                    SELECT id, step_number, lifecycle_stage_id, question_text, guidance
                    FROM workshop_questions
                    WHERE workshop_id = ? AND step_number IN (1, 2)
                    ORDER BY step_number, datetime(created_at), id
                    """,
                    (workshop["id"],),
                ).fetchall()
                for row in paired_rows:
                    paired_questions[row["step_number"]].setdefault(row["lifecycle_stage_id"], row)
                    paired_question_lists[row["step_number"]].setdefault(row["lifecycle_stage_id"], []).append(row)

    stage_ids = [stage["id"] for stage in lifecycle_stages]
    first_question_for_step = next(
        (question for question in questions if question["step_number"] == current_step),
        None,
    )
    if requested_stage_id in stage_ids:
        current_stage_id = requested_stage_id
    elif first_question_for_step is not None:
        current_stage_id = first_question_for_step["lifecycle_stage_id"]
    else:
        current_stage_id = stage_ids[0] if stage_ids else None
    current_stage_index = stage_ids.index(current_stage_id) if current_stage_id in stage_ids else 0

    current_question = None
    if requested_question_id is not None:
        current_question = next(
            (
                question for question in questions
                if question["id"] == requested_question_id
                and question["step_number"] == current_step
                and question["lifecycle_stage_id"] == current_stage_id
            ),
            None,
        )
    if current_question is None:
        current_question = next(
            (
                question for question in questions
                if question["step_number"] == current_step
                and question["lifecycle_stage_id"] == current_stage_id
            ),
            None,
        )

    previous_question = None
    next_question = None
    current_question_number = 0
    if current_question is not None:
        current_index = next(
            index for index, question in enumerate(questions)
            if question["id"] == current_question["id"]
        )
        current_question_number = current_index + 1
        if current_index > 0:
            previous_question = questions[current_index - 1]
        if current_index + 1 < len(questions):
            next_question = questions[current_index + 1]

    current_step_index = step_numbers.index(current_step) if current_step in step_numbers else 0
    previous_step = step_numbers[current_step_index - 1] if current_step_index > 0 else None
    next_step = step_numbers[current_step_index + 1] if current_step_index + 1 < len(step_numbers) else None
    answered_question_ids = {
        question_id for question_id, response_text in saved_responses.items() if response_text.strip()
    } | set(classified_responses) | set(solution_responses)
    if current_step == 4:
        answered_question_ids = set(strategy_details)
    elif current_step == 5:
        answered_question_ids = set(strategy_scale_choices)
    if current_step == 3:
        completed_stage_ids = set(solution_responses)
    else:
        completed_stage_ids = {
            question["lifecycle_stage_id"]
            for question in questions
            if question["id"] in answered_question_ids
        }

    return render_template(
        "user_step.html",
        workshop=workshop,
        lifecycle_stages=lifecycle_stages,
        questions=questions,
        current_step=current_step,
        current_stage_id=current_stage_id,
        current_stage_index=current_stage_index,
        current_question=current_question,
        previous_question=previous_question,
        next_question=next_question,
        current_question_number=current_question_number,
        saved_responses=saved_responses,
        classified_responses=classified_responses,
        solution_responses=solution_responses,
        strategy_details=strategy_details,
        selected_strategy_ids=selected_strategy_ids,
        strategy_scale_choices=strategy_scale_choices,
        strategy_scale_definitions=strategy_scale_definitions,
        paired_questions=paired_questions,
        paired_question_lists=paired_question_lists,
        answered_question_ids=answered_question_ids,
        completed_stage_ids=completed_stage_ids,
        completed_step_numbers=completed_step_numbers,
        steps=step_rows,
        previous_step=previous_step,
        next_step=next_step,
    )


@app.post("/user-step/responses/<int:question_id>")
def save_step_response(question_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))

    response_text = request.form.get("response_text", "").strip()
    with get_db() as conn:
        question = conn.execute(
            """
            SELECT id, workshop_id, step_number, lifecycle_stage_id
            FROM workshop_questions
            WHERE id = ?
            """,
            (question_id,),
        ).fetchone()
        if question is None:
            return redirect(url_for("user_step"))

        if question["step_number"] == 2:
            return redirect(
                url_for(
                    "user_step",
                    workshop_id=question["workshop_id"],
                    step=2,
                    stage_id=question["lifecycle_stage_id"],
                    question_id=question["id"],
                    classification_required=1,
                )
            )

        conn.execute(
            """
            INSERT INTO workshop_responses (user_id, question_id, response_text)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, question_id) DO UPDATE SET
                response_text = excluded.response_text,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, question_id, response_text),
        )

    return redirect(
        url_for(
            "user_step",
            workshop_id=question["workshop_id"],
            step=question["step_number"],
            stage_id=question["lifecycle_stage_id"],
            question_id=question["id"],
            saved=1,
        )
    )


@app.post("/user-step/classified-responses/<int:question_id>")
def add_classified_response(question_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))

    response_text = request.form.get("response_text", "").strip()
    polarity = request.form.get("polarity", "")
    category = request.form.get("category", "")
    classification = request.form.get("classification", "")
    if ":" in classification:
        polarity, category = classification.split(":", 1)
    with get_db() as conn:
        question = conn.execute(
            "SELECT id, workshop_id, step_number, lifecycle_stage_id FROM workshop_questions WHERE id = ?",
            (question_id,),
        ).fetchone()
        if question is None or question["step_number"] != 2:
            return redirect(url_for("user_step"))

        if not response_text or polarity not in {"advantage", "disadvantage"} or category not in {"social", "ecological", "economic"}:
            return redirect(url_for("user_step", workshop_id=question["workshop_id"], step=2,
                                    stage_id=question["lifecycle_stage_id"], question_id=question_id,
                                    classification_required=1))

        conn.execute(
            """
            INSERT INTO workshop_classified_responses
                (user_id, question_id, response_text, polarity, category)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, question_id, response_text, polarity, category),
        )

    return redirect(url_for("user_step", workshop_id=question["workshop_id"], step=2,
                            stage_id=question["lifecycle_stage_id"], question_id=question_id, saved=1))


@app.post("/user-step/classified-responses/<int:response_id>/delete")
def delete_classified_response(response_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))

    with get_db() as conn:
        response = conn.execute(
            """
            SELECT r.id, q.id AS question_id, q.workshop_id, q.step_number, q.lifecycle_stage_id
            FROM workshop_classified_responses AS r
            JOIN workshop_questions AS q ON q.id = r.question_id
            WHERE r.id = ? AND r.user_id = ?
            """,
            (response_id, user_id),
        ).fetchone()
        if response is None:
            return redirect(url_for("user_step"))
        conn.execute("DELETE FROM workshop_classified_responses WHERE id = ? AND user_id = ?", (response_id, user_id))

    return redirect(url_for("user_step", workshop_id=response["workshop_id"], step=response["step_number"],
                            stage_id=response["lifecycle_stage_id"], question_id=response["question_id"]))


@app.post("/user-step/solution-responses/<int:stage_id>")
def add_solution_response(stage_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))

    response_text = request.form.get("response_text", "").strip()
    category = request.form.get("category", "")
    workshop_id = request.form.get("workshop_id", type=int)
    with get_db() as conn:
        valid_pair = conn.execute(
            """
            SELECT 1
            FROM lifecycle_stages AS s
            JOIN workshops AS w ON w.id = ?
            WHERE s.id = ?
            """,
            (workshop_id, stage_id),
        ).fetchone()
        if valid_pair is None:
            return redirect(url_for("user_step"))
        if not response_text or category not in {"social", "ecological", "economic"}:
            return redirect(url_for("user_step", workshop_id=workshop_id, step=3,
                                    stage_id=stage_id,
                                    classification_required=1))
        conn.execute(
            """
            INSERT INTO workshop_comparison_responses
                (user_id, workshop_id, lifecycle_stage_id, response_text, category)
            VALUES (?, ?, ?, ?, ?)
            """,
            (user_id, workshop_id, stage_id, response_text, category),
        )

    return redirect(url_for("user_step", workshop_id=workshop_id, step=3,
                            stage_id=stage_id, saved=1))


@app.post("/user-step/solution-responses/<int:response_id>/delete")
def delete_solution_response(response_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))
    with get_db() as conn:
        response = conn.execute(
            """SELECT r.id, r.workshop_id, r.lifecycle_stage_id
               FROM workshop_comparison_responses AS r
               WHERE r.id = ? AND r.user_id = ?""",
            (response_id, user_id),
        ).fetchone()
        if response is None:
            return redirect(url_for("user_step"))
        conn.execute("DELETE FROM workshop_comparison_responses WHERE id = ? AND user_id = ?", (response_id, user_id))
    return redirect(url_for("user_step", workshop_id=response["workshop_id"], step=3,
                            stage_id=response["lifecycle_stage_id"]))


@app.post("/user-step/strategy-details/<int:strategy_id>")
def save_strategy_details(strategy_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))

    lsc = request.form.get("lsc", "").strip()
    measurement = request.form.get("measurement", "").strip()
    comments = request.form.get("comments", "").strip()
    lifecycle_stage_id = request.form.get("lifecycle_stage_id", type=int)
    category = request.form.get("category", "")

    with get_db() as conn:
        strategy = conn.execute(
            """
            SELECT id, workshop_id, lifecycle_stage_id
            FROM workshop_comparison_responses
            WHERE id = ? AND user_id = ?
            """,
            (strategy_id, user_id),
        ).fetchone()
        stage_exists = conn.execute(
            "SELECT 1 FROM lifecycle_stages WHERE id = ?",
            (lifecycle_stage_id,),
        ).fetchone()
        if strategy is None:
            return redirect(url_for("user_step", step=4))
        if stage_exists is None or category not in {"social", "ecological", "economic"}:
            return redirect(url_for("user_step", workshop_id=strategy["workshop_id"], step=4,
                                    stage_id=strategy["lifecycle_stage_id"], question_id=strategy_id,
                                    classification_required=1))

        conn.execute(
            """
            INSERT INTO workshop_strategy_details
                (user_id, strategy_response_id, lsc, measurement, comments, lifecycle_stage_id, category)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, strategy_response_id) DO UPDATE SET
                lsc = excluded.lsc,
                measurement = excluded.measurement,
                comments = excluded.comments,
                lifecycle_stage_id = excluded.lifecycle_stage_id,
                category = excluded.category,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, strategy_id, lsc, measurement, comments, lifecycle_stage_id, category),
        )

    return redirect(url_for("user_step", workshop_id=strategy["workshop_id"], step=4,
                            stage_id=strategy["lifecycle_stage_id"], question_id=strategy_id, saved=1))


@app.post("/user-step/strategy-selection/<int:strategy_id>")
def update_strategy_selection(strategy_id):
    user_id = session.get("user_id")
    if user_id is None:
        return ("Sign in required", 401)
    selected = request.form.get("selected") == "1"
    with get_db() as conn:
        strategy = conn.execute(
            "SELECT id FROM workshop_comparison_responses WHERE id = ? AND user_id = ?",
            (strategy_id, user_id),
        ).fetchone()
        if strategy is None:
            return ("Strategy not found", 404)
        if selected:
            conn.execute(
                "INSERT OR IGNORE INTO workshop_selected_strategies (user_id, strategy_response_id) VALUES (?, ?)",
                (user_id, strategy_id),
            )
        else:
            conn.execute(
                "DELETE FROM workshop_selected_strategies WHERE user_id = ? AND strategy_response_id = ?",
                (user_id, strategy_id),
            )
    return ("", 204)


@app.post("/user-step/strategy-scale/<int:strategy_id>")
def save_strategy_scale(strategy_id):
    user_id = session.get("user_id")
    if user_id is None:
        return redirect(url_for("login"))
    scale_value = request.form.get("scale_value", type=int)
    definition = request.form.get("definition", "").strip()
    if scale_value is None or not 0 <= scale_value <= 9:
        return redirect(url_for("user_step", step=5))

    with get_db() as conn:
        strategy = conn.execute(
            """
            SELECT r.id, r.workshop_id, COALESCE(d.lifecycle_stage_id, r.lifecycle_stage_id) AS lifecycle_stage_id
            FROM workshop_comparison_responses AS r
            JOIN workshop_selected_strategies AS ss
                 ON ss.strategy_response_id = r.id AND ss.user_id = r.user_id
            LEFT JOIN workshop_strategy_details AS d
                 ON d.strategy_response_id = r.id AND d.user_id = r.user_id
            WHERE r.id = ? AND r.user_id = ?
            """,
            (strategy_id, user_id),
        ).fetchone()
        if strategy is None:
            return redirect(url_for("user_step", step=5))
        conn.execute(
            """
            INSERT INTO workshop_strategy_scale_choices (user_id, strategy_response_id, scale_value)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, strategy_response_id) DO UPDATE SET
                scale_value = excluded.scale_value,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, strategy_id, scale_value),
        )
        conn.execute(
            """
            INSERT INTO workshop_strategy_scale_definitions
                (user_id, strategy_response_id, scale_value, definition)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, strategy_response_id, scale_value) DO UPDATE SET
                definition = excluded.definition,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, strategy_id, scale_value, definition),
        )

    return redirect(url_for("user_step", workshop_id=strategy["workshop_id"], step=5,
                            stage_id=strategy["lifecycle_stage_id"], question_id=strategy_id, saved=1))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(debug=True, use_reloader=False, port=port)
