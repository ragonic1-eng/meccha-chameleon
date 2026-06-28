# Universal container image (works on Railway, Fly.io, Render, or any host).
FROM node:20-slim

WORKDIR /app
COPY . .

# --omit=optional skips the local-only asset pipeline tools (fbx2gltf, sharp);
# the converted map assets are already committed under client/public/maps.
RUN npm install --omit=optional && npm run build

ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
