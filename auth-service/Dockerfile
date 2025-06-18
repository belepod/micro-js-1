FROM node:18-alpine

WORKDIR /usr/src/app

# Copy package.json from the specific service directory first for caching
COPY auth-service/package*.json ./
RUN npm install

# Copy the service's source code
COPY auth-service/src ./src

# --- NEW: Explicitly copy the shared schemas ---
COPY avro-schemas ./avro-schemas

COPY auth-service/init.sql ./init.sql

CMD [ "npm", "start" ]
