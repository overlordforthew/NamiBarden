-- Course access table for video course purchases
CREATE TABLE IF NOT EXISTS nb_course_access (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES nb_customers(id),
  course_id VARCHAR(50) NOT NULL,
  access_token VARCHAR(64) UNIQUE NOT NULL,
  email VARCHAR(255) NOT NULL,
  stripe_session_id VARCHAR(255),
  purchased_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  UNIQUE(customer_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_course_access_token ON nb_course_access(access_token);
CREATE INDEX IF NOT EXISTS idx_course_access_customer ON nb_course_access(customer_id);
CREATE INDEX IF NOT EXISTS idx_course_access_course ON nb_course_access(course_id);
CREATE INDEX IF NOT EXISTS idx_course_access_email ON nb_course_access(email);
