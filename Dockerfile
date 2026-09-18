# AutoBoard：零运行时依赖，只用 Node 内置模块
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

# 容器内必须绑 0.0.0.0，由 compose / 反向代理对外暴露
ENV BOARD_HOST=0.0.0.0 \
    BOARD_PORT=7788 \
    BOARD_DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 7788

CMD ["node", "src/server.mjs"]
