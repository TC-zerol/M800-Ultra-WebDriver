FROM python:3.9-slim

WORKDIR /app

# 纯静态页面，无需安装依赖，直接复制全部文件
COPY . .

EXPOSE 54777

# 静态文件服务器，绑定 54777 端口
CMD ["python", "-m", "http.server", "54777", "--bind", "0.0.0.0"]
