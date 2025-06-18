FROM node:18-alpine

WORKDIR /usr/src/app

# Copy package.json from the specific service directory first for caching
COPY tenant-manager/package*.json ./
RUN npm install

# Copy the service's source code
COPY tenant-manager/src ./src

# --- NEW: Explicitly copy the shared schemas ---
COPY avro-schemas ./avro-schemas

COPY tenant-manager/init.sql ./init.sql

CMD [ "npm", "start" ]
