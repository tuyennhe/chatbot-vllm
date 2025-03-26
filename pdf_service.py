# pdf_service.py
import os
import logging
import uuid
import PyPDF2
import re
import numpy as np
import faiss
import time
from typing import List, Dict, Any
from sentence_transformers import SentenceTransformer
import threading

logger = logging.getLogger(__name__)

# Khởi tạo model embedding
embedding_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

# Lưu trữ dữ liệu PDF của người dùng
user_pdf_data = {}

# Khóa để đồng bộ hóa truy cập vào dữ liệu
pdf_data_lock = threading.Lock()

# Thời gian tồn tại tối đa của session (30 phút)
SESSION_TIMEOUT = 30 * 60  # 30 phút tính bằng giây

# Định kỳ xóa các session hết hạn
def cleanup_expired_sessions():
    current_time = time.time()
    with pdf_data_lock:
        expired_clients = []
        for client_id, data in user_pdf_data.items():
            if current_time - data.get("last_access", 0) > SESSION_TIMEOUT:
                expired_clients.append(client_id)
        
        for client_id in expired_clients:
            logger.info(f"Cleaning up expired session for client: {client_id}")
            del user_pdf_data[client_id]

# Khởi động một thread để định kỳ dọn dẹp các session hết hạn
def start_cleanup_thread():
    def cleanup_thread():
        while True:
            try:
                cleanup_expired_sessions()
            except Exception as e:
                logger.error(f"Error in cleanup thread: {str(e)}")
            time.sleep(300)  # Chạy mỗi 5 phút
    
    thread = threading.Thread(target=cleanup_thread, daemon=True)
    thread.start()

# Khởi động thread dọn dẹp
start_cleanup_thread()

def simple_sentence_tokenize(text):
    """Chia văn bản thành các câu đơn giản"""
    sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
    return [s.strip() for s in sentences if s.strip()]

def semantic_chunking(text, max_chunk_size=1000, similarity_threshold=0.7):
    """Chia văn bản thành các đoạn có ngữ nghĩa liên quan"""
    sentences = simple_sentence_tokenize(text)
    
    if not sentences:
        return []
    
    sentence_embeddings = embedding_model.encode(sentences)
    
    from sklearn.metrics.pairwise import cosine_similarity
    similarity_matrix = cosine_similarity(sentence_embeddings)
    
    chunks = []
    current_chunk = []
    current_chunk_text = ""
    
    for i, sentence in enumerate(sentences):
        if not current_chunk or (len(current_chunk) > 0 and 
                               np.mean([similarity_matrix[i][j] for j in current_chunk]) >= similarity_threshold):
            if len(current_chunk_text + sentence) <= max_chunk_size:
                current_chunk.append(i)
                current_chunk_text += " " + sentence
            else:
                chunks.append({
                    "content": current_chunk_text.strip(),
                    "sentences": [sentences[j] for j in current_chunk]
                })
                current_chunk = [i]
                current_chunk_text = sentence
        else:
            chunks.append({
                "content": current_chunk_text.strip(),
                "sentences": [sentences[j] for j in current_chunk]
            })
            current_chunk = [i]
            current_chunk_text = sentence
    
    if current_chunk_text:
        chunks.append({
            "content": current_chunk_text.strip(),
            "sentences": [sentences[j] for j in current_chunk]
        })
    
    return chunks

def read_pdf(file_path, max_pages=30):
    """Đọc file PDF và chia thành các đoạn văn bản"""
    try:
        pdf_reader = PyPDF2.PdfReader(file_path)
        num_pages = len(pdf_reader.pages)
        pages_to_read = min(num_pages, max_pages)
        
        all_chunks = []
        
        for page_num in range(pages_to_read):
            page = pdf_reader.pages[page_num]
            page_text = page.extract_text()
            
            if not page_text:
                continue
                
            page_chunks = semantic_chunking(page_text)
            
            for chunk in page_chunks:
                chunk["source"] = os.path.basename(file_path)
                chunk["page"] = page_num + 1
                chunk["type"] = "PDF"
                all_chunks.append(chunk)
                
        return all_chunks
    except Exception as e:
        logger.exception(f"Lỗi khi đọc file PDF: {str(e)}")
        return [{"content": f"Lỗi khi đọc file PDF: {str(e)}", "source": os.path.basename(file_path), "type": "Error"}]

def get_user_pdf_session(client_id):
    """Lấy hoặc tạo session mới cho người dùng"""
    with pdf_data_lock:
        if client_id not in user_pdf_data:
            user_pdf_data[client_id] = {
                "index": faiss.IndexFlatL2(384),  # Dimension của embedding model
                "chunks": [],
                "metadata": [],
                "file_info": {},
                "last_access": time.time()
            }
        else:
            # Cập nhật thời gian truy cập
            user_pdf_data[client_id]["last_access"] = time.time()
        
        return user_pdf_data[client_id]

def process_pdf_file(file_path, client_id):
    """Xử lý file PDF và lưu trữ dữ liệu"""
    # Xóa dữ liệu cũ khi người dùng tải lên file mới
    clear_pdf_data(client_id)
    
    session = get_user_pdf_session(client_id)
    
    # Đọc và xử lý file PDF
    file_name = os.path.basename(file_path)
    chunks = read_pdf(file_path)
    
    with pdf_data_lock:
        # Thêm vào FAISS index
        for i, chunk in enumerate(chunks):
            # Tạo metadata cho chunk
            metadata = {
                "source_file": file_name,
                "chunk_index": i,
                "page": chunk.get("page", 1)
            }
            
            # Lưu chunk và metadata
            chunk_embedding = embedding_model.encode([chunk["content"]])
            session["index"].add(chunk_embedding)
            session["chunks"].append(chunk["content"])
            session["metadata"].append(metadata)
        
        # Lưu thông tin file
        session["file_info"][file_name] = {
            "path": file_path,
            "chunks": len(chunks),
            "pages": max([chunk.get("page", 1) for chunk in chunks], default=0)
        }
        
        # Cập nhật thời gian truy cập
        session["last_access"] = time.time()
    
    return {
        "status": "success",
        "file_name": file_name,
        "chunks": len(chunks),
        "total_chunks": len(session["chunks"])
    }

def clear_pdf_data(client_id):
    """Xóa toàn bộ dữ liệu PDF của người dùng"""
    with pdf_data_lock:
        if client_id in user_pdf_data:
            user_pdf_data[client_id] = {
                "index": faiss.IndexFlatL2(384),
                "chunks": [],
                "metadata": [],
                "file_info": {},
                "last_access": time.time()
            }
            return True
    return False

def retrieve_relevant_chunks(query, client_id, top_k=5):
    """Tìm kiếm các đoạn văn bản liên quan đến câu hỏi"""
    session = get_user_pdf_session(client_id)
    
    with pdf_data_lock:
        if len(session["chunks"]) == 0:
            return []
        
        # Cập nhật thời gian truy cập
        session["last_access"] = time.time()
        
        # Tạo embedding cho câu hỏi
        query_embedding = embedding_model.encode([query])
        
        # Tìm kiếm các đoạn văn bản gần nhất
        distances, indices = session["index"].search(query_embedding, min(top_k, len(session["chunks"])))
        
        results = []
        for i, idx in enumerate(indices[0]):
            if idx < len(session["chunks"]):
                results.append({
                    "content": session["chunks"][idx],
                    "metadata": session["metadata"][idx],
                    "score": float(distances[0][i]),
                    "ref_id": i + 1
                })
    
    return results

def get_pdf_db_info(client_id):
    """Lấy thông tin về dữ liệu PDF đã tải lên"""
    session = get_user_pdf_session(client_id)
    
    with pdf_data_lock:
        # Cập nhật thời gian truy cập
        session["last_access"] = time.time()
        
        total_chunks = len(session["chunks"])
        total_files = len(session["file_info"])
        
        file_info = []
        for file_name, info in session["file_info"].items():
            file_info.append({
                "name": file_name,
                "chunks": info["chunks"],
                "pages": info["pages"]
            })
    
    return {
        "total_chunks": total_chunks,
        "total_files": total_files,
        "files": file_info
    }