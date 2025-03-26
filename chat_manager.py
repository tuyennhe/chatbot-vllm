# chat_manager.py
import json
import logging
import uuid
import asyncio
from typing import Dict, List, Set
from fastapi import WebSocket, WebSocketDisconnect

from ai_service import AIService
from pdf_service import retrieve_relevant_chunks, get_pdf_db_info, clear_pdf_data

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        # Lưu trữ các kết nối websocket đang hoạt động
        self.active_connections: Dict[str, WebSocket] = {}
        # Lưu trữ lịch sử trò chuyện cho mỗi người dùng
        self.chat_histories: Dict[str, List[Dict[str, str]]] = {}
        # Theo dõi người dùng đang nhận stream
        self.streaming_clients: Set[str] = set()
    
    async def connect(self, websocket: WebSocket, client_id: str):
        """
        Kết nối một client vào websocket
        """
        await websocket.accept()
        self.active_connections[client_id] = websocket
        
        # Khởi tạo lịch sử trò chuyện nếu chưa có
        if client_id not in self.chat_histories:
            self.chat_histories[client_id] = [
                {"role": "system", "content": """Bạn là một trợ lý AI thông minh và hữu ích. 
                Khi trả lời:
                1. Luôn cung cấp câu trả lời đầy đủ, chi tiết và có giá trị.
                2. Tránh trả lời quá ngắn gọn như "hồng tín!" hoặc "biết nhé."
                3. Giải thích ý tưởng một cách rõ ràng và mạch lạc.
                4. Khi trả lời về code, hãy sử dụng định dạng code block với 3 dấu backtick (```).
                5. Khi trả lời về kết quả của code, hãy thêm dòng comment "# Kết quả: X" để hiển thị kết quả.
                6. Sử dụng đúng định dạng markdown cho tiêu đề, danh sách, bảng, v.v.
                7. Đảm bảo code được định dạng đúng và dễ đọc.
                """}
            ]
        
        logger.info(f"Client connected: {client_id}")
    
    def disconnect(self, client_id: str):
        """
        Ngắt kết nối websocket
        """
        if client_id in self.active_connections:
            # Không cần đóng websocket vì nó đã được đóng bởi FastAPI
            del self.active_connections[client_id]
            
            # Xóa client khỏi danh sách đang stream
            if client_id in self.streaming_clients:
                self.streaming_clients.remove(client_id)
                
            logger.info(f"Client disconnected: {client_id}")
    
    def clear_history(self, client_id: str):
        """
        Xóa lịch sử trò chuyện của một client
        """
        if client_id in self.chat_histories:
            # Giữ lại system message
            self.chat_histories[client_id] = [
                {"role": "system", "content": """Bạn là một trợ lý AI thông minh và hữu ích được phát triển bởi công ty ATIN. 
                Khi trả lời:
                1. Luôn cung cấp câu trả lời đầy đủ, chi tiết và có giá trị.
                2. Tránh trả lời quá ngắn gọn như "hồng tín!" hoặc "biết nhé."
                3. Giải thích ý tưởng một cách rõ ràng và mạch lạc.
                4. Khi trả lời về code, hãy sử dụng định dạng code block với 3 dấu backtick (```).
                5. Khi trả lời về kết quả của code, hãy thêm dòng comment "# Kết quả: X" để hiển thị kết quả.
                6. Sử dụng đúng định dạng markdown cho tiêu đề, danh sách, bảng, v.v.
                7. Đảm bảo code được định dạng đúng và dễ đọc.
                """}
            ]
            logger.info(f"Chat history cleared for client: {client_id}")
    
    async def send_message(self, client_id: str, message: Dict):
        """
        Gửi tin nhắn đến một client cụ thể
        """
        try:
            if client_id in self.active_connections:
                websocket = self.active_connections[client_id]
                # Kiểm tra xem websocket có còn mở không
                if websocket.client_state.CONNECTED:
                    await websocket.send_text(json.dumps(message))
                else:
                    logger.warning(f"Cannot send message to client {client_id}: WebSocket is closed")
                    # Xóa kết nối đã đóng
                    self.disconnect(client_id)
        except RuntimeError as e:
            if "Cannot call 'send' once a close message has been sent" in str(e):
                logger.warning(f"WebSocket for client {client_id} was closed during send operation")
                self.disconnect(client_id)
            else:
                raise
    
    async def stream_callback(self, client_id: str, chunk: str):
        """
        Callback để xử lý từng chunk của stream response
        """
        try:
            if client_id in self.active_connections and client_id in self.streaming_clients:
                # Kiểm tra trạng thái kết nối trước khi gửi
                websocket = self.active_connections[client_id]
                if hasattr(websocket, 'client_state') and websocket.client_state.CONNECTED:
                    await self.send_message(client_id, {
                        "type": "stream_chunk",
                        "content": chunk
                    })
                else:
                    logger.warning(f"Cannot send stream chunk to client {client_id}: WebSocket is closed")
                    # Xóa client khỏi danh sách streaming
                    if client_id in self.streaming_clients:
                        self.streaming_clients.remove(client_id)
        except RuntimeError as e:
            if "Cannot call 'send' once a close message has been sent" in str(e):
                logger.warning(f"WebSocket for client {client_id} was closed during streaming")
                # Xóa client khỏi danh sách streaming
                if client_id in self.streaming_clients:
                    self.streaming_clients.remove(client_id)
            else:
                raise
    
    async def handle_chat(self, client_id: str, message_content: str = None, action: str = None):
        """
        Xử lý tin nhắn chat và gọi AI để phản hồi với streaming
        """
        # Kiểm tra xem client có còn kết nối không
        if client_id not in self.active_connections:
            logger.warning(f"Client {client_id} is no longer connected")
            return
            
        try:
            # Xử lý heartbeat
            if action == "heartbeat":
                await self.send_message(client_id, {
                    "type": "heartbeat_ack"
                })
                return
                
            # Xử lý clear history
            if action == "clear_history":
                self.clear_history(client_id)
                await self.send_message(client_id, {"type": "history_cleared"})
                return
            
            # Xử lý get_pdf_info
            if action == "get_pdf_info":
                pdf_info = get_pdf_db_info(client_id)
                await self.send_message(client_id, {
                    "type": "pdf_info",
                    "info": pdf_info
                })
                return
            
            # Xử lý clear_pdf_data
            if action == "clear_pdf_data":
                clear_pdf_data(client_id)
                await self.send_message(client_id, {
                    "type": "pdf_cleared"
                })
                return
            
            # Xử lý pdf_query
            if action == "pdf_query" and message_content:
                # Thêm tin nhắn của người dùng vào lịch sử
                self.chat_histories[client_id].append({"role": "user", "content": message_content})
                
                # Tìm kiếm các đoạn văn bản liên quan từ PDF
                relevant_chunks = retrieve_relevant_chunks(message_content, client_id)
                
                # Đánh dấu client đang nhận stream
                self.streaming_clients.add(client_id)
                
                # Gửi message bắt đầu stream
                await self.send_message(client_id, {
                    "type": "stream_start"
                })
                
                try:
                    # Chuẩn bị prompt với context từ PDF
                    enhanced_prompt = message_content
                    
                    if relevant_chunks:
                        context = "Thông tin từ tài liệu PDF:\n\n"
                        for i, chunk in enumerate(relevant_chunks):
                            context += f"{i+1}. {chunk['content']}\n\n"
                        
                        # Thêm context vào prompt
                        enhanced_prompt = f"{message_content}\n\n{context}\n\nTrả lời dựa trên thông tin từ tài liệu. Nếu thông tin không có trong tài liệu, hãy nói rõ điều đó. Không đề cập đến các tham chiếu hoặc nguồn trong câu trả lời."
                    else:
                        # Nếu không có chunk nào liên quan
                        enhanced_prompt = f"{message_content}\n\n(Lưu ý: Không tìm thấy thông tin liên quan trong tài liệu PDF đã tải lên. Vui lòng kiểm tra lại câu hỏi hoặc tải lên tài liệu phù hợp.)"
                    
                    # Thiết lập timeout cho toàn bộ quá trình xử lý
                    try:
                        # Tạo chat history tạm thời với enhanced_prompt
                        temp_history = self.chat_histories[client_id][:-1] + [{"role": "user", "content": enhanced_prompt}]
                        
                        # Gọi AI để lấy phản hồi với streaming và timeout
                        ai_response_task = asyncio.create_task(
                            AIService.generate_response_stream(
                                temp_history,
                                lambda chunk: asyncio.create_task(self.stream_callback(client_id, chunk))
                            )
                        )
                        
                        # Đặt timeout 60 giây cho toàn bộ quá trình
                        ai_response = await asyncio.wait_for(ai_response_task, timeout=60)
                        
                    except asyncio.TimeoutError:
                        logger.warning(f"Response generation timeout for client {client_id}")
                        # Gửi thông báo timeout
                        try:
                            await self.send_message(client_id, {
                                "type": "stream_chunk",
                                "content": "\n\n[Quá thời gian chờ. Phản hồi bị cắt ngắn.]"
                            })
                        except Exception as e:
                            logger.error(f"Error sending timeout message: {str(e)}")
                        ai_response = "(Phản hồi bị cắt ngắn do quá thời gian chờ)"
                    
                    # Kiểm tra xem client có còn kết nối không
                    if client_id in self.active_connections:
                        # Gửi message kết thúc stream
                        await self.send_message(client_id, {
                            "type": "stream_end"
                        })
                    
                    # Xóa client khỏi danh sách đang stream
                    if client_id in self.streaming_clients:
                        self.streaming_clients.remove(client_id)
                    
                    # Thêm phản hồi của AI vào lịch sử
                    self.chat_histories[client_id].append({"role": "assistant", "content": ai_response})
                    
                    return ai_response
                    
                except Exception as e:
                    logger.exception(f"Error handling PDF query: {str(e)}")
                    
                    # Xóa client khỏi danh sách đang stream
                    if client_id in self.streaming_clients:
                        self.streaming_clients.remove(client_id)
                    
                    # Kiểm tra xem client có còn kết nối không
                    if client_id in self.active_connections:
                        try:
                            error_response = {
                                "type": "error",
                                "message": "Có lỗi xảy ra khi xử lý truy vấn PDF."
                            }
                            await self.send_message(client_id, error_response)
                            
                            # Đảm bảo gửi tin nhắn kết thúc stream
                            await self.send_message(client_id, {
                                "type": "stream_end"
                            })
                        except Exception as send_error:
                            logger.error(f"Error sending error message: {str(send_error)}")
                
                return
            
            # Tiếp tục xử lý tin nhắn chat như bình thường
            if message_content:
                # Thêm tin nhắn của người dùng vào lịch sử
                self.chat_histories[client_id].append({"role": "user", "content": message_content})
                
                # Giới hạn lịch sử để tránh context quá dài
                # Giữ system message và 10 tin nhắn gần nhất
                if len(self.chat_histories[client_id]) > 11:  # 1 system + 10 messages
                    system_message = self.chat_histories[client_id][0]
                    self.chat_histories[client_id] = [system_message] + self.chat_histories[client_id][-10:]
                
                # Đánh dấu client đang nhận stream
                self.streaming_clients.add(client_id)
                
                # Gửi message bắt đầu stream
                await self.send_message(client_id, {
                    "type": "stream_start"
                })
                
                # Thiết lập timeout cho toàn bộ quá trình xử lý
                try:
                    # Gọi AI để lấy phản hồi với streaming và timeout
                    ai_response_task = asyncio.create_task(
                        AIService.generate_response_stream(
                            self.chat_histories[client_id],
                            lambda chunk: asyncio.create_task(self.stream_callback(client_id, chunk))
                        )
                    )
                    
                    # Đặt timeout 60 giây cho toàn bộ quá trình
                    ai_response = await asyncio.wait_for(ai_response_task, timeout=60)
                    
                except asyncio.TimeoutError:
                    logger.warning(f"Response generation timeout for client {client_id}")
                    # Gửi thông báo timeout
                    try:
                        await self.send_message(client_id, {
                            "type": "stream_chunk",
                            "content": "\n\n[Quá thời gian chờ. Phản hồi bị cắt ngắn.]"
                        })
                    except Exception as e:
                        logger.error(f"Error sending timeout message: {str(e)}")
                    ai_response = "(Phản hồi bị cắt ngắn do quá thời gian chờ)"
                
                # Kiểm tra xem client có còn kết nối không
                if client_id in self.active_connections:
                    # Gửi message kết thúc stream
                    await self.send_message(client_id, {
                        "type": "stream_end"
                    })
                
                # Xóa client khỏi danh sách đang stream
                if client_id in self.streaming_clients:
                    self.streaming_clients.remove(client_id)
                
                # Thêm phản hồi của AI vào lịch sử
                self.chat_histories[client_id].append({"role": "assistant", "content": ai_response})
                
                return ai_response
                
        except Exception as e:
            logger.exception(f"Error handling chat: {str(e)}")
            
            # Xóa client khỏi danh sách đang stream
            if client_id in self.streaming_clients:
                self.streaming_clients.remove(client_id)
            
            # Kiểm tra xem client có còn kết nối không
            if client_id in self.active_connections:
                try:
                    error_response = {
                        "type": "error",
                        "message": "Có lỗi xảy ra khi xử lý tin nhắn của bạn."
                    }
                    await self.send_message(client_id, error_response)
                    
                    # Đảm bảo gửi tin nhắn kết thúc stream
                    await self.send_message(client_id, {
                        "type": "stream_end"
                    })
                except Exception as send_error:
                    logger.error(f"Error sending error message: {str(send_error)}")

# Tạo instance của connection manager
connection_manager = ConnectionManager()
