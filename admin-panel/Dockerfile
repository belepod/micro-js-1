# ---- Stage 1: Build the React App ----
FROM node:18-alpine AS builder

WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Build the application for production
# This creates a 'dist' folder with static files
RUN npm run build


# ---- Stage 2: Serve the App with NGINX ----
FROM nginx:1.23-alpine AS production

# Copy the static files from the build stage
COPY --from=builder /usr/src/app/dist /usr/share/nginx/html

# Copy the custom NGINX configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 for the NGINX server
EXPOSE 80

# The default NGINX command will be run automatically, so no CMD is needed.
