FROM node:24.22.2-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ENV NODE_ENV=production AUTH_DATA_DIR=/data PORT=8080
WORKDIR /app
COPY package.json server.mjs admin.mjs ./
COPY src ./src
# A named volume mounted here inherits this ownership on first use.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
