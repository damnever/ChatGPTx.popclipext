.PHONY: build

build:
	rm -rf *.js ChatGPTx.popclipextz ChatGPTx.popclipext
	mkdir -p ChatGPTx.popclipext
	tsc
	cp ./README.md ./LICENSE ./main.js ./Config.json ./top-languages-from-chatgpt.json ChatGPTx.popclipext/
	zip -r ChatGPTx.popclipextz ChatGPTx.popclipext
	rm -rf *.js ChatGPTx.popclipext
