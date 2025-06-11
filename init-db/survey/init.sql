CREATE TABLE survey_users (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL, -- This comes from the auth service
    username VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
