FROM node:18-alpine

WORKDIR /usr/src/app

# Copy package.json from the specific service directory first for caching
COPY survey-service/package*.json ./
RUN npm install

# Copy the service's source code
COPY survey-service/src ./src

# --- NEW: Explicitly copy the shared schemas ---
COPY avro-schemas ./avro-schemas

CMD [ "npm", "start" ]
