# ai_service.py
import aiohttp
import logging
import json
import asyncio
import time
from typing import List, Dict, Callable, Optional

# Cấu hình API VLLM
VLLM_API_URL = "http://localhost:8000/v1/completions"
VLLM_STREAM_API_URL = "http://localhost:8000/v1/completions"
VLLM_MODEL = "Qwen/Qwen2.5-3B-Instruct-AWQ"  # Thêm tên mô hình mặc định

logger = logging.getLogger(__name__)

class AIService:
    @staticmethod
    async def generate_response_stream(
        messages: List[Dict[str, str]], 
        callback: Callable[[str], None]
    ) -> str:
        """
        Gửi request đến VLLM API và stream phản hồi
        """
        try:
            # Format prompt từ messages
            prompt = AIService.format_prompt(messages)
            
            # Chuẩn bị request cho VLLM
            request_data = {
                "model": VLLM_MODEL,  # Thêm trường model vào request
                "prompt": prompt,
                "max_tokens": 1024,  # Tăng max_tokens lên để có câu trả lời dài hơn
                "temperature": 0.3,
                "stream": True,
                "stop": ["<|im_end|>"]
            }
            
            full_response = ""
            last_chunk_time = time.time()
            stream_timeout = 30  # 30 giây timeout cho stream
            
            # Gửi request đến VLLM API với stream=True
            async with aiohttp.ClientSession() as session:
                try:
                    async with session.post(
                        VLLM_STREAM_API_URL,
                        json=request_data,
                        headers={"Content-Type": "application/json"},
                        timeout=aiohttp.ClientTimeout(total=60)  # 60 giây timeout tổng
                    ) as response:
                        if response.status != 200:
                            error_text = await response.text()
                            logger.error(f"VLLM API error: {response.status} - {error_text}")
                            logger.error(f"Request data: {json.dumps(request_data)}")
                            error_msg = "Xin lỗi, tôi đang gặp vấn đề kỹ thuật. Vui lòng thử lại sau."
                            callback(error_msg)
                            return error_msg
                        
                        # Xử lý stream response
                        async for line in response.content:
                            # Cập nhật thời gian nhận chunk cuối cùng
                            last_chunk_time = time.time()
                            
                            if line:
                                try:
                                    line_text = line.decode('utf-8').strip()
                                    
                                    # Bỏ qua các dòng trống
                                    if not line_text or line_text == "data: [DONE]":
                                        continue
                                        
                                    # Loại bỏ prefix "data: " nếu có
                                    if line_text.startswith("data: "):
                                        line_text = line_text[6:]
                                    
                                    # Parse JSON
                                    chunk = json.loads(line_text)
                                    if "choices" in chunk and len(chunk["choices"]) > 0:
                                        delta = chunk["choices"][0].get("text", "")
                                        
                                        # Chỉ xử lý nếu delta không phải là phần của prompt
                                        if full_response or not prompt.endswith(delta):
                                            full_response += delta
                                            # Gửi từng delta ngay lập tức
                                            callback(delta)
                                            # Thêm small delay để đảm bảo UI có thời gian cập nhật
                                            await asyncio.sleep(0.01)
                                except json.JSONDecodeError as e:
                                    logger.error(f"JSON decode error: {str(e)}, line: {line_text}")
                                    continue
                                except Exception as e:
                                    logger.error(f"Error parsing stream chunk: {str(e)}")
                                    continue
                            
                            # Kiểm tra timeout
                            if time.time() - last_chunk_time > stream_timeout:
                                logger.warning("Stream timeout reached")
                                # Gửi thông báo timeout
                                callback("\n\n[Quá thời gian chờ. Phản hồi bị cắt ngắn.]")
                                break
                
                except asyncio.TimeoutError:
                    logger.error("Request timeout")
                    callback("\n\n[Quá thời gian chờ phản hồi từ máy chủ.]")
                    return full_response + "\n\n[Quá thời gian chờ phản hồi từ máy chủ.]"
                
                except aiohttp.ClientError as e:
                    logger.error(f"AIOHTTP client error: {str(e)}")
                    callback("\n\n[Lỗi kết nối đến máy chủ AI.]")
                    return full_response + "\n\n[Lỗi kết nối đến máy chủ AI.]"
            
            # Loại bỏ token kết thúc nếu có
            if "<|im_end|>" in full_response:
                full_response = full_response.split("<|im_end|>")[0]
            
            return full_response.strip()
                    
        except Exception as e:
            logger.exception(f"Error generating AI response: {str(e)}")
            error_msg = "Xin lỗi, tôi đang gặp vấn đề kỹ thuật. Vui lòng thử lại sau."
            callback(error_msg)
            return error_msg
    
    @staticmethod
    async def generate_response(messages: List[Dict[str, str]]) -> str:
        """
        Gửi request đến VLLM API và nhận phản hồi (non-streaming)
        """
        try:
            # Format prompt từ messages
            prompt = AIService.format_prompt(messages)
            
            # Chuẩn bị request cho VLLM
            request_data = {
                "model": VLLM_MODEL,  # Thêm trường model vào request
                "prompt": prompt,
                "max_tokens": 1024,
                "temperature": 0.3,
                "stop": ["<|im_end|>"]
            }
            
            # Gửi request đến VLLM API
            async with aiohttp.ClientSession() as session:
                try:
                    async with session.post(
                        VLLM_API_URL,
                        json=request_data,
                        headers={"Content-Type": "application/json"},
                        timeout=aiohttp.ClientTimeout(total=30)  # 30 giây timeout
                    ) as response:
                        if response.status != 200:
                            error_text = await response.text()
                            logger.error(f"VLLM API error: {response.status} - {error_text}")
                            logger.error(f"Request data: {json.dumps(request_data)}")
                            return "Xin lỗi, tôi đang gặp vấn đề kỹ thuật. Vui lòng thử lại sau."
                        
                        # Parse phản hồi
                        response_data = await response.json()
                        
                        # Lấy text từ phản hồi
                        generated_text = response_data["choices"][0]["text"]
                        
                        # Loại bỏ phần prompt gốc nếu có
                        if generated_text.startswith(prompt):
                            generated_text = generated_text[len(prompt):]
                        
                        # Loại bỏ token kết thúc nếu có
                        if "<|im_end|>" in generated_text:
                            generated_text = generated_text.split("<|im_end|>")[0]
                        
                        return generated_text.strip()
                except asyncio.TimeoutError:
                    logger.error("Request timeout in non-streaming mode")
                    return "Xin lỗi, tôi đang gặp vấn đề kết nối. Vui lòng thử lại sau."
                except aiohttp.ClientError as e:
                    logger.error(f"AIOHTTP client error in non-streaming mode: {str(e)}")
                    return "Xin lỗi, tôi đang gặp vấn đề kết nối. Vui lòng thử lại sau."
                    
        except Exception as e:
            logger.exception(f"Error generating AI response: {str(e)}")
            return "Xin lỗi, tôi đang gặp vấn đề kỹ thuật. Vui lòng thử lại sau."
    
    @staticmethod
    def format_prompt(messages: List[Dict[str, str]]) -> str:
        """
        Format tin nhắn thành prompt phù hợp với Qwen2.5-3B-Instruct
        """
        formatted_prompt = ""
        
        for msg in messages:
            if msg["role"] == "user":
                formatted_prompt += f"<|im_start|>user\n{msg['content']}<|im_end|>\n"
            elif msg["role"] == "assistant":
                # Đảm bảo code blocks được giữ nguyên định dạng
                content = msg["content"]
                formatted_prompt += f"<|im_start|>assistant\n{content}<|im_end|>\n"
            elif msg["role"] == "system":
                formatted_prompt += f"<|im_start|>system\n{msg['content']}<|im_end|>\n"
        
        # Thêm token bắt đầu cho assistant để model biết cần trả lời
        formatted_prompt += "<|im_start|>assistant\n"
        
        return formatted_prompt
