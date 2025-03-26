# main.py
import logging
import json
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
# Thêm vào phần imports
import os
import tempfile
import uuid
import time
import threading
from fastapi import UploadFile, File, Form
from fastapi.responses import JSONResponse, RedirectResponse

from pdf_service import process_pdf_file, clear_pdf_data, retrieve_relevant_chunks, get_pdf_db_info

from chat_manager import connection_manager

# Cấu hình logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)

logger = logging.getLogger(__name__)

# Cấu hình ứng dụng
APP_HOST = "0.0.0.0"
APP_PORT = 8081  # Thay đổi cổng tùy theo nhu cầu
DEBUG = True

# Thêm thư mục uploads nếu chưa tồn tại
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Lifespan context manager
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Khởi tạo các tài nguyên khi ứng dụng khởi động
    logger.info("Application startup")
    
    # Tạo thư mục uploads nếu chưa tồn tại
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    
    # Định kỳ dọn dẹp các file tạm thời
    def cleanup_temp_files():
        while True:
            try:
                now = time.time()
                # Xóa các file tạm thời cũ hơn 1 giờ
                for filename in os.listdir(UPLOAD_DIR):
                    file_path = os.path.join(UPLOAD_DIR, filename)
                    if os.path.isfile(file_path) and now - os.path.getmtime(file_path) > 3600:
                        os.unlink(file_path)
                        logger.info(f"Deleted old temporary file: {file_path}")
            except Exception as e:
                logger.error(f"Error in cleanup thread: {str(e)}")
            time.sleep(1800)  # Chạy mỗi 30 phút
    
    # Khởi động thread dọn dẹp
    cleanup_thread = threading.Thread(target=cleanup_temp_files, daemon=True)
    cleanup_thread.start()
    
    yield
    
    # Dọn dẹp khi ứng dụng đóng
    logger.info("Application shutdown")

# Khởi tạo FastAPI app với lifespan
app = FastAPI(title="Qwen Chatbot API", lifespan=lifespan)

# Khởi tạo templates
templates = Jinja2Templates(directory="templates")

# Khởi tạo static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Routes
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/pdf", response_class=HTMLResponse)
async def pdf_chat_page(request: Request):
    return templates.TemplateResponse("pdf_chat.html", {"request": request})

@app.post("/upload_pdf")
async def upload_pdf(pdf_file: UploadFile = File(...), client_id: str = Form(...)):
    if not pdf_file.filename.lower().endswith('.pdf'):
        return JSONResponse(content={
            "status": "error",
            "message": "Chỉ hỗ trợ file PDF"
        }, status_code=400)
    
    # Kiểm tra kích thước file
    content = await pdf_file.read()
    file_size = len(content)
    
    # Giới hạn 10MB
    if file_size > 10 * 1024 * 1024:
        return JSONResponse(content={
            "status": "error",
            "message": "File quá lớn. Vui lòng tải lên file PDF nhỏ hơn 10MB."
        }, status_code=400)
    
    try:
        # Tạo tên file duy nhất để tránh xung đột
        unique_filename = f"{uuid.uuid4().hex}_{pdf_file.filename}"
        temp_file_path = os.path.join(UPLOAD_DIR, unique_filename)
        
        # Lưu file
        with open(temp_file_path, "wb") as temp_file:
            temp_file.write(content)
        
        # Xử lý file PDF
        result = process_pdf_file(temp_file_path, client_id)
        
        # Không xóa file ngay, để cho thread dọn dẹp xử lý sau
        
        return JSONResponse(content={
            "status": "success",
            "file_name": pdf_file.filename,
            "chunks": result["chunks"],
            "total_chunks": result["total_chunks"]
        })
    except Exception as e:
        logger.exception(f"Error processing PDF: {str(e)}")
        
        # Xóa file tạm nếu có lỗi
        if 'temp_file_path' in locals():
            try:
                os.unlink(temp_file_path)
            except:
                pass
                
        return JSONResponse(content={
            "status": "error",
            "message": f"Lỗi khi xử lý file PDF: {str(e)}"
        }, status_code=500)

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    # Kết nối websocket
    await connection_manager.connect(websocket, client_id)
    
    try:
        while True:
            try:
                # Nhận tin nhắn từ client với timeout
                data = await asyncio.wait_for(websocket.receive_text(), timeout=60)
                message_data = json.loads(data)
                
                # Xử lý các loại tin nhắn khác nhau
                if message_data.get("action") == "clear_history":
                    await connection_manager.handle_chat(client_id, action="clear_history")
                elif message_data.get("action") == "heartbeat":
                    await connection_manager.handle_chat(client_id, action="heartbeat")
                elif message_data.get("action") == "get_pdf_info":
                    await connection_manager.handle_chat(client_id, action="get_pdf_info")
                elif message_data.get("action") == "clear_pdf_data":
                    await connection_manager.handle_chat(client_id, action="clear_pdf_data")
                elif message_data.get("action") == "pdf_query":
                    # Xử lý truy vấn PDF
                    await connection_manager.handle_chat(
                        client_id=client_id,
                        message_content=message_data.get("content", ""),
                        action="pdf_query"
                    )
                elif "content" in message_data:
                    # Xử lý tin nhắn thông thường
                    await connection_manager.handle_chat(
                        client_id=client_id,
                        message_content=message_data.get("content", "")
                    )
            except asyncio.TimeoutError:
                # Timeout khi chờ tin nhắn từ client, gửi heartbeat để kiểm tra kết nối
                try:
                    # Ping client để kiểm tra kết nối
                    pong_waiter = await websocket.ping()
                    await asyncio.wait_for(pong_waiter, timeout=5)
                    logger.debug(f"Ping successful for client {client_id}")
                except Exception as e:
                    # Nếu ping thất bại, client có thể đã ngắt kết nối
                    logger.warning(f"Ping failed for client {client_id}: {str(e)}")
                    raise WebSocketDisconnect()
            except json.JSONDecodeError:
                logger.warning(f"Invalid JSON from client {client_id}")
                continue
            except RuntimeError as e:
                if "Cannot call 'receive' once a close message has been sent" in str(e):
                    logger.warning(f"WebSocket for client {client_id} was closed")
                    raise WebSocketDisconnect()
                else:
                    raise
            
    except WebSocketDisconnect:
        # Ngắt kết nối
        connection_manager.disconnect(client_id)
        logger.info(f"Client disconnected: {client_id}")
    except Exception as e:
        # Xử lý lỗi
        logger.exception(f"Error in websocket: {str(e)}")
        connection_manager.disconnect(client_id)

# Chạy ứng dụng
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=APP_HOST, port=APP_PORT, reload=DEBUG)
