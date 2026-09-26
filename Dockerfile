FROM node:20-alpine

WORKDIR /app

# 安装依赖（利用镜像层缓存）
COPY package*.json ./
RUN npm ci --omit=dev

# 拷贝应用代码
COPY server.js example.json ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
