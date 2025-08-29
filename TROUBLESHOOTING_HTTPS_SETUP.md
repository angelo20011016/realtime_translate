# Nginx + Let's Encrypt 首次設定失敗的故障排除紀錄

## 1. 問題描述

當使用 Docker、Nginx 和 Certbot (Let's Encrypt) 設定 HTTPS 服務時，在首次啟動時遇到 Port 80 或 Port 443 測試不通過、無法訪問的問題。

## 2. 根本原因

此問題的根本原因是「先有雞還是先有蛋」的循環依賴：

1.  **Nginx 的設定 (`nginx.conf`)** 要求監聽 443 port (HTTPS)，並需要讀取到 SSL 憑證檔案 (`fullchain.pem`, `privkey.pem`) 才能成功啟動。
2.  **Certbot** 需要透過 HTTP (Port 80) 連線到一個正在運行的伺服器，來完成 `http-01` 域名驗證，才能成功**生成** SSL 憑證。

在首次設定時，因為憑證還不存在，所以 Nginx 無法啟動。因為 Nginx 無法啟動，所以 Certbot 無法驗證並生成憑證。這導致了服務啟動失敗。

## 3. 解決方案步驟

解決此問題的標準流程是「分階段設定」：先讓 Nginx 以最簡化的 HTTP 模式啟動，完成憑證申請後，再切換到最終的 HTTPS 設定。

---

### **步驟一：使用暫時的 Nginx 設定**

修改 `nginx.conf`，使其暫時只監聽 Port 80，並且**移除**所有與 Port 443、SSL、HTTPS 重定向相關的設定。

**暫時的 `nginx.conf` 範例：**
```nginx
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    server {
        listen 80;
        # 改成你的域名
        server_name your_domain.com;

        # Certbot 驗證所需的路徑
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        # 暫時將所有其他流量代理到後端應用
        location / {
            proxy_pass http://app:8001; # "app:8001" 是後端服務的位址
            proxy_set_header Host $host;
            # (其他代理設定)
        }
    }
}
```

---

### **步驟二：啟動服務**

使用修改後的暫時設定，重新建立並啟動服務。

```bash
docker-compose up -d --force-recreate nginx
```

---

### **步驟三：申請憑證 (先測試，後正式)**

1.  **執行測試申請**：使用 `--staging` 參數來測試，避免因為設定錯誤而被 Let's Encrypt 官方限制請求。
    ```bash
    docker-compose run --rm certbot certonly --webroot --webroot-path /var/www/certbot -d your_domain.com --email your_email@example.com --agree-tos --no-eff-email --staging
    ```

2.  **執行正式申請**：測試成功後，移除 `--staging` 參數申請正式憑證。如果遇到詢問是否覆蓋，可以加上 `--force-renewal` 參數。
    ```bash
    docker-compose run --rm certbot certonly --webroot --webroot-path /var/www/certbot -d your_domain.com --email your_email@example.com --agree-tos --no-eff-email --force-renewal
    ```

---

### **步驟四：還原 Nginx 為最終設定**

當憑證申請成功後 (`/etc/letsencrypt/live/your_domain.com/` 路徑下已存在憑證檔案)，就可以將 `nginx.conf` 修改為最終的生產環境設定。

**最終的 `nginx.conf` 範例：**
```nginx
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    # HTTP伺服器：監聽 Port 80，自動重定向到 HTTPS
    server {
        listen 80;
        server_name your_domain.com;

        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        location / {
            return 301 https://$host$request_uri;
        }
    }

    # HTTPS伺服器：監聽 Port 443
    server {
        listen 443 ssl;
        server_name your_domain.com;

        # SSL 憑證路徑
        ssl_certificate /etc/letsencrypt/live/your_domain.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/your_domain.com/privkey.pem;

        location / {
            proxy_pass http://app:8001;
            # (其他代理設定)
        }
    }
}
```

---

### **步驟五：最後重啟**

執行最後一次重啟，讓 Nginx 載入包含 SSL 的最終設定。

```bash
docker-compose restart nginx
```

服務現已設定完成，可透過 HTTPS 正常訪問。
